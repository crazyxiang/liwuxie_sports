/**
 * PC 开发预览服务（零依赖，只用 Node 内置模块）
 *
 *  1. 托管 app/web 静态文件
 *  2. 代理抓取豆包直播 https://www.doubaozhibo.com/replays，解析成 JSON
 *  3. 代理 m3u8 切片（上游没有 CORS 头，必须走这里转发）
 *
 * 启动：node server/dev-server.mjs
 * 访问：http://127.0.0.1:8787
 */
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('../app/web', import.meta.url)));
const PORT = Number(process.env.PORT || 8787);
const TRIBUTE_FILE = path.join(ROOT, '..', '..', '.cache', 'tribute.json');
const TRIBUTE_ADMIN_TOKEN = process.env.TRIBUTE_ADMIN_TOKEN || '';
const SITE = 'https://www.doubaozhibo.com';
const QQ = 'https://matchweb.sports.qq.com';
const NBA_ID = '100000'; // 腾讯体育的 NBA 赛事 ID

// 科比页远程数据：jsDelivr 主线路（国内相对快），raw GitHub 备用
const KOBE_DATA_URLS = [
  'https://cdn.jsdelivr.net/gh/crazyxiang/liwuxie_sports@main/app/web/assets/data/kobe.json',
  'https://raw.githubusercontent.com/crazyxiang/liwuxie_sports/main/app/web/assets/data/kobe.json'
];
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const CATEGORIES = {
  basketball: '篮球',
  football: '足球'
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.apk': 'application/vnd.android.package-archive'
};

// ---------------- 抓取 ----------------

function request(target, binary, depth = 0, referer = SITE + '/') {
  return new Promise((resolve, reject) => {
    const headers = {
      'User-Agent': UA,
      Accept: '*/*',
      'Accept-Language': 'zh-CN,zh;q=0.9'
    };
    // 存片 CDN 会拒绝带站点 Referer 的请求，所以抓流时不带 Referer
    if (referer) headers.Referer = referer;

    const req = (target.startsWith('http:') ? http : https).get(
      target,
      { headers },
      (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && depth < 4) {
          res.resume();
          return resolve(request(new URL(res.headers.location, target).toString(), binary, depth + 1, referer));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error('HTTP ' + res.statusCode));
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          resolve({
            headers: res.headers,
            buffer: buf,
            text: binary ? null : buf.toString('utf8')
          });
        });
        res.on('error', reject);
      }
    );
    req.setTimeout(20000, () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
  });
}

function fetchText(target, referer) {
  return request(target, false, 0, referer).then((r) => r.text);
}

// ---------------- 本地缓存（写盘，重启不丢） ----------------
const CACHE_DIR = path.resolve(ROOT, '../../.cache');
const cache = new Map();

function localDay(ts) {
  const d = new Date(ts);
  return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
}

function cacheFile(key) {
  return path.join(CACHE_DIR, key.replace(/[^\w.-]/g, '_') + '.json');
}

function readDisk(key) {
  try {
    return JSON.parse(fs.readFileSync(cacheFile(key), 'utf8'));
  } catch {
    return null;
  }
}

function writeDisk(key, entry) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(cacheFile(key), JSON.stringify(entry));
  } catch {
    /* 缓存写失败不影响主流程 */
  }
}

/**
 * 回放列表的缓存策略（NBA 大多在北京时间凌晨到下午 3 点之间打完）：
 *  - 15:00–24:00：比赛基本结束，当天 15 点后抓过一次就复用，不再重复请求
 *  - 00:00–15:00：还在打 / 刚打完，数据会变，10 分钟内复用缓存，过期重新抓
 */
function replayListFresh(at) {
  const now = new Date();
  if (now.getHours() >= 15) {
    return localDay(at) === localDay(Date.now()) && new Date(at).getHours() >= 15;
  }
  return Date.now() - at < 10 * 60 * 1000;
}

/**
 * @param {object} opts
 *   ttl:  毫秒 | 'day'（当天只取一次） | 'replay'（回放列表按时段策略） | 'forever'
 *   force: 手动刷新，忽略缓存
 *   disk:  是否落盘（带有时效签名的播放地址不要落盘）
 */
async function cached(key, loader, opts = {}) {
  const ttl = opts.ttl == null ? 60 * 1000 : opts.ttl;
  const entry = cache.get(key) || readDisk(key);

  if (entry && !opts.force) {
    const fresh =
      ttl === 'forever'
        ? true
        : ttl === 'replay'
          ? replayListFresh(entry.at)
          : ttl === 'day'
            ? localDay(entry.at) === localDay(Date.now())
            : Date.now() - entry.at < ttl;
    if (fresh) {
      cache.set(key, entry);
      return entry.value;
    }
  }

  const value = await loader();
  const next = { at: Date.now(), value };
  cache.set(key, next);
  if (opts.disk !== false) writeDisk(key, next);
  return value;
}

// ---------------- 解析 ----------------

function stripTags(html) {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 把 "2026年11月17日 太阳 vs 掘金 赛事回放" 拆成结构化字段 */
function parseTitle(title) {
  const dateM = title.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日\s*/);
  const rest = title
    .slice(dateM ? dateM[0].length : 0)
    .replace(/(赛事回放|录像回放|全场录像|回放|集锦).*$/, '')
    .trim();

  const vsM = rest.match(/^(.*?)\s*(?:vs|VS|Vs)\s*(.*)$/);
  const home = vsM ? vsM[1].trim() : rest;
  const away = vsM ? vsM[2].trim() : '';

  const date = dateM
    ? `${dateM[1]}-${('0' + dateM[2]).slice(-2)}-${('0' + dateM[3]).slice(-2)}`
    : '';

  return { date, home, away };
}

function parseList(html) {
  const items = [];
  const chunks = html.split('<a href="/replay/').slice(1);

  for (const chunk of chunks) {
    const cut = chunk.slice(0, chunk.indexOf('</a>'));
    const idM = chunk.match(/^(\d+-\d+)"/);
    if (!idM) continue;

    const titleM = cut.match(/<h2>([\s\S]*?)<\/h2>/);
    if (!titleM) continue;

    const coverM = cut.match(/<img[^>]+src="([^"]+)"/);
    const timeM = cut.match(/<time>([\s\S]*?)<\/time>/);
    const leagueM = cut.match(/<span>([^<]*)<\/span>\s*<time>/);
    const title = stripTags(titleM[1]);

    items.push({
      id: `/replay/${idM[1]}`,
      url: `${SITE}/replay/${idM[1]}?source=dooqiuluxiang`,
      title,
      cover: coverM ? coverM[1] : '',
      time: timeM ? stripTags(timeM[1]) : '',
      league: leagueM ? stripTags(leagueM[1]) : '',
      ...parseTitle(title)
    });
  }

  const pager = html.match(/<span>\s*(\d+)\s*\/\s*(\d+)\s*<\/span>/);

  return {
    items,
    page: pager ? Number(pager[1]) : 1,
    totalPages: pager ? Number(pager[2]) : 1
  };
}

/** 播放页的线路名与 m3u8 都写在 Nuxt 的 payload 里，按出现顺序配对 */
function parseDetail(html) {
  const decoded = html.replace(/\\u002F/g, '/');

  const titleM = html.match(/<title>([\s\S]*?)<\/title>/);
  const title = stripTags(titleM ? titleM[1] : '').replace(/\s*-\s*豆包直播.*$/, '');

  const coverM = decoded.match(/https:\/\/[^"]*replay-thumbnails\/[^"]*\.(?:jpg|png|webp)/);

  const lines = [];
  const urlRe = /https:\/\/[^"\s]+?\.m3u8/g;
  let m;

  while ((m = urlRe.exec(decoded))) {
    const url = m[0];
    if (lines.some((l) => l.url === url)) continue;

    // 往 URL 前面找最近的一个「xx回放」，就是这条线路的名字
    const before = decoded.slice(Math.max(0, m.index - 400), m.index);
    const labels = [...before.matchAll(/"([^"]{1,20}回放)"/g)];
    const full = labels.length ? labels[labels.length - 1][1] : '回放';

    lines.push({ label: full.replace(/回放$/, '') || '回放', full, url });
  }

  const preferred = lines.findIndex((l) => /中文高清/.test(l.full));

  return { title, cover: coverM ? coverM[0] : '', lines, defaultIndex: preferred >= 0 ? preferred : 0 };
}

// ---------------- 腾讯体育：球队/球员排名 ----------------

/** 从接口的 values 数组里按 code 取一项 */
function pick(values, code) {
  const hit = values.find((v) => v.code === code);
  return hit ? hit.value : '';
}

function valName(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  return v.cnName || v.enName || '';
}

const RANK_COLS = ['rank', 'team', 'wins', 'losses', 'winRate', 'streak'];
const PLAYER_COLS = ['rank', 'player', 'team', 'games', 'rankValue'];

function parseRank(json, kind) {
  if (!json || json.code !== 0 || !json.data) throw new Error('排名接口返回异常');

  const tabs = (json.data.groups || []).map((group) => ({
    code: group.code,
    name: group.name,
    tables: (group.tables || []).map((table) => {
      const cols = kind === 'player' ? PLAYER_COLS : RANK_COLS;
      const headers = table.headers.filter((h) => cols.includes(h.code)).map((h) => h.name);
      const rows = (table.rows || []).slice(0, kind === 'player' ? 20 : 40).map((row) => {
        const v = row.values;
        const team = pick(v, 'team');
        const player = pick(v, 'player');
        return {
          rank: String(pick(v, 'rank')),
          name: kind === 'player' ? valName(player) : valName(team),
          team: kind === 'player' ? valName(team) : '',
          logo: kind === 'player' ? team.logo || '' : team.logo || '',
          wins: String(pick(v, 'wins')),
          losses: String(pick(v, 'losses')),
          winRate: String(pick(v, 'winRate')),
          streak: String(pick(v, 'streak')),
          games: String(pick(v, 'games')),
          value: String(pick(v, 'rankValue'))
        };
      });
      return { title: table.headers.find((h) => h.idx === 1)?.name || '', headers, rows };
    })
  }));

  return { kind, tabs };
}

// ---------------- 腾讯体育：赛程 ----------------

function parseSchedule(json, date) {
  if (!json || json.code !== 0 || !json.data) throw new Error('赛程接口返回异常');

  const list = json.data[date] || [];
  const items = [];

  for (const m of list) {
    // 只要两队都有队徽和队名的那一行
    if (!m.leftBadge || !m.rightBadge || !m.leftName || !m.rightName) continue;
    if (String(m.competitionId) !== NBA_ID) continue;

    items.push({
      mid: m.mid,
      time: String(m.startTime || '').slice(11, 16),
      startTime: m.startTime || '',
      home: { name: m.leftName, logo: m.leftBadge, score: m.leftGoal || '' },
      away: { name: m.rightName, logo: m.rightBadge, score: m.rightGoal || '' },
      desc: m.matchDesc || '',
      live: String(m.livePeriod || '0') // 0 未开始 / 1 进行中 / 2 已结束
    });
  }

  return { date, items };
}

// ---------------- JRKAN 直播 ----------------

const JRKAN = 'https://www.jrkan77.com';

/** 直播线路域名写在页面内联脚本里（atob 编码），跟着解析，站点换域名也能跟上 */
function parseHosts(html) {
  const hosts = {};
  for (const m of html.matchAll(/(line\d+):\s*atob\("([^"]+)"\)/g)) {
    try {
      hosts[m[1]] = Buffer.from(m[2], 'base64').toString('utf8').replace(/\/+$/, '');
    } catch {
      /* 解析不了的线路直接忽略 */
    }
  }
  return hosts;
}

function innerText(block, re) {
  const m = block.match(re);
  return m ? stripTags(m[1]) : '';
}

/** 队徽大多是站内相对路径，补成绝对地址才能在 App 里显示 */
function absoluteLogo(src) {
  if (!src) return '';
  if (src.startsWith('//')) return 'https:' + src;
  if (src.startsWith('/')) return JRKAN + src;
  return src;
}

/**
 * 直播数据是 index.js 里一串 document.write(...) 拼出来的
 * 每场比赛一个 <ul class="item play" data-lid="赛事id,项目id,赛事id">，项目 1 足球 / 2 篮球
 */
function parseLives(js, hosts) {
  const items = [];

  for (const raw of js.split('<ul class="item play').slice(1)) {
    const lid = (raw.match(/data-lid="([^"]+)"/) || [])[1] || '';
    const sportType = lid.split(',')[1];
    // 项目 1 足球 / 2 篮球，其他项目（网球、电竞等）不要
    if (sportType !== '1' && sportType !== '2') continue;
    const sport = sportType === '1' ? 'football' : 'basketball';

    const league = innerText(raw, /<li class="lab_events"[^>]*><span class="name">([^<]*)<\/span>/);
    const time = innerText(raw, /<li class="lab_time">([^<]*)<\/li>/);
    const homeName = innerText(raw, /<li class="lab_team_home">[\s\S]*?<strong class="name">([^<]*)<\/strong>/);
    const awayName = innerText(raw, /<li class="lab_team_away">[\s\S]*?<strong class="name">([^<]*)<\/strong>/);
    const homeLogo = absoluteLogo((raw.match(/<li class="lab_team_home">[\s\S]*?<img[^>]+src="([^"]+)"/) || [])[1] || '');
    const awayLogo = absoluteLogo((raw.match(/<li class="lab_team_away">[\s\S]*?<img[^>]+src="([^"]+)"/) || [])[1] || '');
    const vsM = raw.match(/<li class="lab_vs[^"]*">([\s\S]*?)<\/li>/);
    const status = vsM ? stripTags(vsM[1]) : '';

    // 只要 .lab_channel 下的第 2 个 <a>（第 1 个是随机线路占位，不是真实地址）
    let url = '';
    const channel = raw.match(/<li class="lab_channel">([\s\S]*?)<\/li>/);
    if (channel) {
      const anchors = [...channel[1].matchAll(/<a[^>]*>/g)];
      const second = anchors[1] ? anchors[1][0] : '';
      const pm = second.match(/getPlayUrl\("(line\d+)",\s*"(\d+)"\)/);
      if (pm && hosts[pm[1]]) url = `${hosts[pm[1]]}/play/steam${pm[2]}.html`;
    }

    if (!league || !url) continue;

    items.push({
      id: lid,
      sport,
      league,
      time,
      status,
      home: { name: homeName, logo: homeLogo },
      away: { name: awayName, logo: awayLogo },
      url
    });
  }

  return { items };
}

async function fetchLives() {
  const referer = JRKAN + '/';
  const home = await fetchText(referer, referer);
  const hosts = parseHosts(home);

  const srcM = home.match(/<script[^>]+src="([^"]*index\.js[^"]*)"/);
  const src = srcM
    ? new URL(srcM[1].startsWith('//') ? 'https:' + srcM[1] : srcM[1], referer).toString()
    : 'https://im-imgs-bucket.oss-accelerate.aliyuncs.com/index.js?t_5';

  const js = await fetchText(src, referer);
  return parseLives(js, hosts);
}

/**
 * 直播播放页里列了多条线路（主播解说 / 中文高清 / 高清直播…）。
 * 这些线路是独立的小播放页，没有 X-Frame-Options，可以直接嵌到 App 里播放。
 */
function parseLiveSources(html, base) {
  const lines = [];
  const seen = new Set();

  function add(label, play) {
    if (!play || !/^\/play\//.test(play)) return;
    let abs;
    try {
      abs = new URL(play.replace(/&amp;/g, '&'), base).toString();
    } catch {
      return;
    }
    if (seen.has(abs)) return;
    seen.add(abs);
    lines.push({ label: label || '线路 ' + (lines.length + 1), url: abs });
  }

  for (const m of html.matchAll(/<a\b[^>]*data-play="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)) {
    add(stripTags(m[2]).trim(), m[1].trim());
  }

  // 页面默认的 iframe 播放器作为兜底线路
  const frame = html.match(/<iframe[^>]*class="[^"]*sub_player[^"]*"[^>]*src="([^"]+)"/);
  if (frame) add('默认线路', frame[1]);

  // 高清线路优先：主播解说那几条的 CDN 经常失效，放到最后再试
  const score = (line) => (/高清/.test(line.label) ? 0 : /\/play\/sm\.html/.test(line.url) ? 2 : 1);
  lines.sort((a, b) => score(a) - score(b));

  return lines;
}

// ---------------- m3u8 代理 ----------------

// 真正存片的 CDN 域名经常变，所以不写死白名单：
// 只转发「我们自己在重写播放列表时下发过的地址」，等价于白名单且不会变成开放代理
const allowedUrls = new Map();
const ALLOW_TTL = 2 * 60 * 60 * 1000;
const ALLOW_MAX = 30000;

function registerAllowed(abs) {
  allowedUrls.set(abs, Date.now() + ALLOW_TTL);
  // Map 按插入顺序，超量时淘汰最旧的（一场完整录像的分片数就可能上万，不能整体清空）
  while (allowedUrls.size > ALLOW_MAX) {
    const oldest = allowedUrls.keys().next().value;
    allowedUrls.delete(oldest);
  }
}

function isAllowed(target, parsed) {
  if (/(^|\.)rtmpcdn\.com$/.test(parsed.hostname)) return true;
  const exp = allowedUrls.get(target);
  return Boolean(exp) && exp > Date.now();
}

function proxyUrl(abs) {
  registerAllowed(abs);
  return '/api/hls?u=' + encodeURIComponent(abs);
}

function rewritePlaylist(text, base) {
  return text
    .split(/\r?\n/)
    .map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (t.startsWith('#')) {
        return line.replace(/URI="([^"]+)"/, (_, uri) => {
          try {
            return 'URI="' + proxyUrl(new URL(uri, base).toString()) + '"';
          } catch {
            return _;
          }
        });
      }
      try {
        return proxyUrl(new URL(t, base).toString());
      } catch {
        return line;
      }
    })
    .join('\n');
}

// ---------------- 路由 ----------------

function json(res, code, data) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    // App 里页面来自 file://，跨域请求需要放行
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(data));
}

// ---------------- B 站视频 / 封面（科比经典视频） ---------------

const BILI_API = 'https://api.bilibili.com';
const BILI_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BILI_REF = 'https://www.bilibili.com/';
const biliCache = new Map();

/** BV 号 12 位，av 号纯数字 */
function isBiliId(id) {
  return /^BV[0-9A-Za-z]{10}$/.test(id) || /^av\d+$/.test(id);
}

async function biliGet(pathname) {
  const r = await fetch(BILI_API + pathname, {
    headers: { 'User-Agent': BILI_UA, Referer: BILI_REF }
  });
  if (!r.ok) throw new Error('bilibili HTTP ' + r.status);
  const data = await r.json();
  if (data.code !== 0) throw new Error(data.message || 'bilibili code ' + data.code);
  return data.data;
}

/** 稿件基础信息（标题 / 时长 / 封面），缓存 6 小时 */
async function biliView(id) {
  const key = 'view:' + id;
  const hit = biliCache.get(key);
  if (hit && Date.now() - hit.at < 6 * 60 * 60 * 1000) return hit.data;

  const view = await biliGet(
    id.startsWith('av')
      ? `/x/web-interface/view?aid=${id.slice(2)}`
      : `/x/web-interface/view?bvid=${id}`
  );
  biliCache.set(key, { at: Date.now(), data: view });
  return view;
}

/** 取可直接播放的 mp4 地址（B 站链接约 2 小时过期，所以每次现取并短缓存） */
async function biliPlay(id) {
  const view = await biliView(id);
  const key = 'play:' + view.bvid;
  const hit = biliCache.get(key);
  if (hit && Date.now() - hit.at < 20 * 60 * 1000) return hit.data;

  const play = await biliGet(
    `/x/player/playurl?bvid=${view.bvid}&cid=${view.cid}&qn=64&fnval=0&platform=html5&high_quality=1`
  );
  const durl = (play && play.durl) || [];
  if (!durl.length) throw new Error('没有可播放片源');

  const data = { url: durl[0].url, title: view.title, duration: view.duration, cover: view.pic };
  biliCache.set(key, { at: Date.now(), data });
  return data;
}

/** 视频转发：把 Range 透传给 B 站，浏览器 / 电视才能拖动进度 */
async function handleBiliVideo(req, res, url) {
  const id = url.searchParams.get('bv') || '';
  if (!isBiliId(id)) return json(res, 400, { error: 'bv 不合法' });

  try {
    const info = await biliPlay(id);
    const headers = { 'User-Agent': BILI_UA, Referer: BILI_REF, Origin: BILI_REF };
    if (req.headers.range) headers.Range = req.headers.range;

    const up = await fetch(info.url, { headers });
    if (up.status !== 200 && up.status !== 206) {
      return json(res, 502, { error: '片源不可用', detail: 'HTTP ' + up.status });
    }

    const out = {
      'Content-Type': up.headers.get('content-type') || 'video/mp4',
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store'
    };
    const len = up.headers.get('content-length');
    const range = up.headers.get('content-range');
    if (len) out['Content-Length'] = len;
    if (range) out['Content-Range'] = range;

    res.writeHead(up.status, out);
    Readable.fromWeb(up.body).pipe(res);
  } catch (err) {
    return json(res, 502, { error: '视频加载失败', detail: String(err.message || err) });
  }
}

/** 封面转发：B 站图片带防盗链，加 Referer 才能取到 */
async function handleBiliCover(req, res, url) {
  const id = url.searchParams.get('bv') || '';
  if (!isBiliId(id)) return json(res, 400, { error: 'bv 不合法' });

  try {
    const view = await biliView(id);
    const pic = String(view.pic || '');
    let p;
    try {
      p = new URL(pic);
    } catch {
      return json(res, 404, { error: '没有封面' });
    }
    if (p.protocol !== 'http:' && p.protocol !== 'https:') {
      return json(res, 403, { error: '封面地址未授权' });
    }
    if (!/(^|\.)hdslb\.com$/i.test(p.hostname)) {
      return json(res, 403, { error: '封面地址未授权' });
    }
    // B 站封面常给 http，统一走 https 取
    const picUrl = 'https://' + p.hostname + p.pathname + p.search;

    const up = await fetch(picUrl, { headers: { 'User-Agent': BILI_UA, Referer: BILI_REF } });
    if (!up.ok) return json(res, 404, { error: '封面不可用' });

    res.writeHead(200, {
      'Content-Type': up.headers.get('content-type') || 'image/jpeg',
      'Cache-Control': 'public, max-age=3600',
      'Access-Control-Allow-Origin': '*'
    });
    Readable.fromWeb(up.body).pipe(res);
  } catch (err) {
    return json(res, 502, { error: '封面加载失败', detail: String(err.message || err) });
  }
}

// ---------------- 科比页远程数据（可热更新） ----------------

function kobeJsonValid(data) {
  return data && typeof data === 'object' && Array.isArray(data.videoGroups) && data.videoGroups.length > 0;
}

function kobeNewer(a, b) {
  if (!a) return false;
  if (!b) return true;
  const av = Number(a.version) || 0;
  const bv = Number(b.version) || 0;
  if (av !== bv) return av > bv;
  return String(a.updatedAt || '') > String(b.updatedAt || '');
}

async function refreshKobeCache(base) {
  let best = null;
  for (const src of KOBE_DATA_URLS) {
    try {
      const r = await fetch(src, {
        headers: { 'User-Agent': UA, 'Cache-Control': 'no-cache' },
        signal: AbortSignal.timeout(3500)
      });
      if (!r.ok) continue;
      const data = await r.json();
      if (!kobeJsonValid(data)) continue;
      // 只认比当前缓存/内置数据新的版本，避免 CDN 旧缓存盖掉新数据
      if (base && !kobeNewer(data, base)) continue;
      if (kobeNewer(data, base)) {
        best = data;
        break;
      }
      if (!best || kobeNewer(data, best)) best = data;
    } catch {
      /* 换下一条线路 */
    }
  }
  if (best) {
    writeDisk('kobe-remote', { at: Date.now(), data: best });
    return best;
  }
  return null;
}

async function handleKobe(req, res, url) {
  const force = url.searchParams.get('refresh') === '1';
  const bundled = path.join(ROOT, 'assets/data/kobe.json');
  let bundledData = null;
  try {
    bundledData = JSON.parse(fs.readFileSync(bundled, 'utf8'));
  } catch {
    bundledData = null;
  }
  const entry = readDisk('kobe-remote');
  const base = kobeNewer(bundledData, entry && entry.data) ? bundledData : (entry && entry.data) || bundledData;

  if (!force && entry && kobeJsonValid(entry.data) && !kobeNewer(bundledData, entry.data)) {
    // 命中缓存立即返回，过期了再在后台更新，绝不拖慢首屏
    if (Date.now() - entry.at > 30 * 60 * 1000) refreshKobeCache(base);
    return json(res, 200, entry.data);
  }

  if (force) {
    const remote = await refreshKobeCache(base);
    if (remote) return json(res, 200, remote);
  }

  if (bundledData && kobeJsonValid(bundledData)) {
    // 先给本地打包数据，远端结果后台补进来
    writeDisk('kobe-remote', { at: Date.now(), data: bundledData });
    refreshKobeCache(base);
    return json(res, 200, bundledData);
  }

  if (entry && kobeJsonValid(entry.data)) return json(res, 200, entry.data);
  return json(res, 502, { error: '科比数据不可用', detail: '本地与远端都没有有效数据' });
}

function readTributeStore() {
  try {
    const raw = JSON.parse(fs.readFileSync(TRIBUTE_FILE, 'utf8'));
    if (raw && typeof raw === 'object' && raw.devices && typeof raw.devices === 'object') return raw;
  } catch {
    /* 第一次运行还没有文件 */
  }
  return { devices: {}, updatedAt: '' };
}

function saveTributeStore(store) {
  fs.mkdirSync(path.dirname(TRIBUTE_FILE), { recursive: true });
  const tmp = TRIBUTE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, TRIBUTE_FILE);
}

function tributeHash(id) {
  return crypto.createHash('sha256').update(String(id)).digest('hex').slice(0, 32);
}

function tributeDevice(raw) {
  const id = String(raw || '').trim();
  return /^[A-Za-z0-9_-]{16,64}$/.test(id) ? id : '';
}

function readRequestBody(req, limit = 4096) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > limit) raw = raw.slice(0, limit);
    });
    req.on('end', () => resolve(raw));
    req.on('error', () => resolve(''));
  });
}

async function handleTribute(req, res, url) {
  let payload = {};
  if (req.method === 'POST') {
    const raw = await readRequestBody(req);
    try { payload = raw ? JSON.parse(raw) : {}; } catch { payload = {}; }
  }
  const id = tributeDevice(url.searchParams.get('device') || payload.deviceId);
  if (!id) return json(res, 400, { error: 'device 不合法' });

  const hash = tributeHash(id);
  const store = readTributeStore();
  const devices = store.devices || (store.devices = {});
  const count = Object.keys(devices).length;

  if (req.method === 'POST') {
    let entry = devices[hash];
    let added = false;
    if (!entry) {
      const rank = count + 1;
      entry = devices[hash] = { at: new Date().toISOString(), rank };
      store.updatedAt = new Date().toISOString();
      saveTributeStore(store);
      added = true;
    }
    return json(res, 200, { count: Object.keys(devices).length, mine: true, rank: entry.rank || 0, added });
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: '只支持 GET / POST' });
  const entry = devices[hash];
  return json(res, 200, { count, mine: !!entry, rank: entry ? entry.rank || 0 : 0 });
}

function handleTributeStats(req, res, url) {
  const token = url.searchParams.get('token') || req.headers['x-admin-token'] || '';
  if (TRIBUTE_ADMIN_TOKEN && token !== TRIBUTE_ADMIN_TOKEN) {
    return json(res, 403, { error: '后台口令不正确' });
  }
  const store = readTributeStore();
  const devices = store.devices || {};
  const recent = Object.keys(devices).map((hash) => ({
    id: hash.slice(0, 8),
    at: devices[hash].at || '',
    rank: devices[hash].rank || 0
  })).sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 30);
  return json(res, 200, {
    count: Object.keys(devices).length,
    updatedAt: store.updatedAt || '',
    recent
  });
}

async function handleApi(req, res, url) {
  if (url.pathname === '/api/tribute') return handleTribute(req, res, url);
  if (url.pathname === '/api/tribute/stats') return handleTributeStats(req, res, url);
  if (url.pathname === '/api/kobe') return handleKobe(req, res, url);
  if (url.pathname === '/api/bili/video') return handleBiliVideo(req, res, url);
  if (url.pathname === '/api/bili/cover') return handleBiliCover(req, res, url);

  if (url.pathname === '/api/replays') {
    const category = url.searchParams.get('category') || 'basketball';
    const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
    if (!CATEGORIES[category]) return json(res, 400, { error: '不支持的分类' });

    const force = url.searchParams.get('refresh') === '1';

    try {
      const key = `list:${category}:${page}`;
      const data = await cached(key, async () => {
        const html = await fetchText(`${SITE}/replays?category=${category}&page=${page}`);
        const parsed = parseList(html);
        // 只要 NBA 的比赛
        parsed.items = parsed.items.filter((it) => it.league === 'NBA');
        return { ...parsed, category };
      }, { ttl: 'replay', force });

      // 命中缓存时直接用本地数据，updatedAt 就是上次抓取时间
      return json(res, 200, { ...data, updatedAt: (cache.get(key) || {}).at || Date.now() });
    } catch (err) {
      return json(res, 502, { error: '抓取失败', detail: String(err.message || err) });
    }
  }

  if (url.pathname === '/api/lives') {
    try {
      const key = 'lives';
      // 比分/状态会变，缓存 1 分钟；不落盘，避免重启后展示过期直播
      const data = await cached(key, fetchLives, {
        ttl: 60 * 1000,
        force: url.searchParams.get('refresh') === '1',
        disk: false
      });
      // 默认只回篮球，保证老版本 APK 行为不变；sport=all 一次拿全量
      const sport = url.searchParams.get('sport') || 'basketball';
      const all = (data.items || []).filter((it) => it.sport === 'basketball' || it.sport === 'football');
      const items = sport === 'all' ? all : all.filter((it) => (it.sport || 'basketball') === sport);
      return json(res, 200, { ...data, items, updatedAt: (cache.get(key) || {}).at || Date.now() });
    } catch (err) {
      return json(res, 502, { error: '直播列表加载失败', detail: String(err.message || err) });
    }
  }

  if (url.pathname === '/api/live') {
    const target = url.searchParams.get('u') || '';
    let parsed;
    try {
      parsed = new URL(target);
    } catch {
      return json(res, 400, { error: 'u 不合法' });
    }
    // 只解析直播站点的播放页，避免变成任意地址代理
    if (!/^https?:$/.test(parsed.protocol) || !/^\/play\/steam\d+\.html$/.test(parsed.pathname)) {
      return json(res, 403, { error: '地址未授权' });
    }

    try {
      const data = await cached('live:' + target, async () => {
        const html = await fetchText(target, JRKAN + '/');
        return { lines: parseLiveSources(html, target) };
      }, { ttl: 2 * 60 * 1000, disk: false });
      return json(res, 200, { ...data, source: target });
    } catch (err) {
      return json(res, 502, { error: '直播线路解析失败', detail: String(err.message || err) });
    }
  }

  if (url.pathname === '/api/rank') {
    const kind = url.searchParams.get('kind') === 'player' ? 'player' : 'team';
    const type = kind === 'player' ? 2 : 0;

    try {
      const data = await cached('rank:' + kind, async () => {
        const body = await fetchText(
          `${QQ}/match/api/v2/statistic/rankings?competition_id=${NBA_ID}&type=${type}&scene=pc`
        );
        return parseRank(JSON.parse(body), kind);
      }, { ttl: 30 * 60 * 1000, force: url.searchParams.get('refresh') === '1' });
      return json(res, 200, data);
    } catch (err) {
      return json(res, 502, { error: '排名加载失败', detail: String(err.message || err) });
    }
  }

  if (url.pathname === '/api/schedule') {
    const date = url.searchParams.get('date') || '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json(res, 400, { error: '日期不合法' });

    try {
      const today = new Date();
      const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
      // 过去日期不会变，永久缓存；今天比分在变，缓存 5 分钟
      const ttl = date < todayStr ? 'forever' : date === todayStr ? 5 * 60 * 1000 : 60 * 60 * 1000;

      const data = await cached('schedule:' + date, async () => {
        const body = await fetchText(
          `${QQ}/matchUnion/list?columnId=${NBA_ID}&startTime=${date}&endTime=${date}&timestamp=${Date.now()}`
        );
        return parseSchedule(JSON.parse(body), date);
      }, { ttl, force: url.searchParams.get('refresh') === '1' });
      return json(res, 200, data);
    } catch (err) {
      return json(res, 502, { error: '赛程加载失败', detail: String(err.message || err) });
    }
  }

  if (url.pathname === '/api/replay') {
    const id = url.searchParams.get('id') || '';
    if (!/^\/replay\/\d+-\d+$/.test(id)) return json(res, 400, { error: 'id 不合法' });

    try {
      const data = await cached('detail:' + id, async () => {
        const html = await fetchText(`${SITE}${id}?source=dooqiuluxiang`);
        return parseDetail(html);
      }, { ttl: 5 * 60 * 1000, disk: false });
      return json(res, 200, { id, url: `${SITE}${id}?source=dooqiuluxiang`, ...data });
    } catch (err) {
      return json(res, 502, { error: '抓取失败', detail: String(err.message || err) });
    }
  }

  if (url.pathname === '/api/hls') {
    const target = url.searchParams.get('u') || '';
    let parsed;
    try {
      parsed = new URL(target);
    } catch {
      return json(res, 400, { error: 'u 不合法' });
    }
    if (parsed.protocol !== 'https:' || !isAllowed(target, parsed)) {
      return json(res, 403, { error: '地址未授权' });
    }

    try {
      const upstream = await request(parsed.toString(), true, 0, '');
      const type = String(upstream.headers['content-type'] || '');
      const isPlaylist = /mpegurl|m3u8/i.test(type) || /\.m3u8$/i.test(parsed.pathname);

      if (isPlaylist) {
        const body = rewritePlaylist(upstream.buffer.toString('utf8'), parsed.toString());
        res.writeHead(200, {
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store'
        });
        return res.end(body);
      }

      res.writeHead(200, {
        'Content-Type': type || 'video/mp2t',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=3600'
      });
      return res.end(upstream.buffer);
    } catch (err) {
      return json(res, 502, { error: '转发失败', detail: String(err.message || err) });
    }
  }

  return json(res, 404, { error: '接口不存在' });
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;

  // 安装包放在项目根目录 apk_package/，不在 app/web 里（否则会被打进 APK 自身）
  if (rel.indexOf('/apk_package/') === 0) {
    let name = '';
    try {
      name = decodeURIComponent(rel.slice('/apk_package/'.length));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('400 Bad Request');
      return;
    }
    if (!/^[A-Za-z0-9._-]+\.apk$/i.test(name)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
      return;
    }
    const file = path.join(path.resolve(ROOT, '../..'), 'apk_package', name);
    fs.readFile(file, (err, buf) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'application/vnd.android.package-archive',
        'Content-Disposition': `attachment; filename="${name}"`,
        'Content-Length': buf.length,
        'Cache-Control': 'no-store'
      });
      res.end(buf);
    });
    return;
  }

  const file = path.join(ROOT, decodeURIComponent(rel));

  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
      return;
    }

    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const total = st.size;
    const range = req.headers.range || '';
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);

    let start = 0;
    let end = total - 1;
    let code = 200;
    if (m && total > 0) {
      if (!m[1]) {
        start = Math.max(0, total - Number(m[2]));
      } else {
        start = Number(m[1]);
        if (m[2]) end = Math.min(Number(m[2]), total - 1);
      }
      if (start <= end && start < total) code = 206;
      else {
        res.writeHead(416, { 'Content-Range': `bytes */${total}` }).end();
        return;
      }
    }

    const headers = {
      'Content-Type': type,
      'Content-Length': end - start + 1,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store'
    };
    if (code === 206) headers['Content-Range'] = `bytes ${start}-${end}/${total}`;

    res.writeHead(code, headers);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(file, { start, end }).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url);
  } else {
    serveStatic(req, res, url.pathname);
  }
});

// 监听 0.0.0.0，手机 / 电视才能通过局域网 IP 访问
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  无邪体育 · 预览已启动\n  电脑：http://127.0.0.1:${PORT}\n  电视：http://<本机局域网IP>:${PORT}?api=http://<本机局域网IP>:${PORT}\n`);
});
