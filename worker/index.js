/**
 * 无邪体育 · Cloudflare Worker 版数据服务
 *
 * 把 server/dev-server.mjs 的「抓取 + 解析 + m3u8 转发」搬到了边缘节点：
 *  - 与静态页面同域，页面里的 /api/* 直接命中这里，无需再填 API_BASE
 *  - 抓取结果写进 Cloudflare 边缘缓存（Cache API），命中就不打上游
 *  - 上游挂了/超时，回吐上一次成功的旧数据（带 X-Stale 头），页面不至于白屏
 *  - m3u8 里的切片地址用 HMAC 签名，避免这个 Worker 变成公开代理被刷额度
 */

const SITE = 'https://www.doubaozhibo.com';
const QQ = 'https://matchweb.sports.qq.com';
const JRKAN = 'https://www.jrkan77.com';
const NBA_ID = '100000';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const CATEGORIES = { basketball: '篮球', football: '足球' };

// 科比页远程数据：jsDelivr 主线路，raw GitHub 备用
const KOBE_DATA_URLS = [
  'https://cdn.jsdelivr.net/gh/crazyxiang/liwuxie_sports@main/app/web/assets/data/kobe.json',
  'https://raw.githubusercontent.com/crazyxiang/liwuxie_sports/main/app/web/assets/data/kobe.json'
];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Access-Control-Allow-Headers': '*'
};

// Cache API 在本地 Node 自测时不存在，做个兜底
const CACHE = typeof caches !== 'undefined' ? caches.default : null;

// ---------------- 抓取 ----------------

async function upstream(target, { referer = SITE + '/', timeout = 15000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const headers = {
      'User-Agent': UA,
      Accept: '*/*',
      'Accept-Language': 'zh-CN,zh;q=0.9'
    };
    if (referer) headers.Referer = referer;
    const res = await fetch(target, { headers, signal: ctrl.signal, redirect: 'follow' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(target, referer) {
  const res = await upstream(target, { referer });
  return res.text();
}

// ---------------- 缓存 ----------------
/**
 * 两级缓存：
 *   主键  —— 按 ttl 新鲜度命中，命中就不打上游
 *   stale —— 长期保存的「上一次成功」，上游异常时兜底
 */
async function cachedJson(request, ttl, loader, opts = {}) {
  const { ctx = null, force = false } = opts;
  const staleKey = new Request(request.url + (request.url.includes('?') ? '&' : '?') + '__stale=1');

  if (CACHE && !force) {
    const fresh = await CACHE.match(request);
    if (fresh) return fresh;
  }

  let payload;
  try {
    payload = await loader();
  } catch (err) {
    // 上游失败：尽量给旧数据，别给白屏
    if (CACHE) {
      const old = await CACHE.match(staleKey);
      if (old) {
        const body = await old.text();
        return new Response(body, {
          headers: {
            ...CORS,
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Stale': '1'
          }
        });
      }
    }
    return json({ error: String(err.message || err) }, 502);
  }

  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const headers = {
    ...CORS,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'public, max-age=' + ttl
  };
  const res = new Response(body, { headers });

  if (CACHE) {
    const put1 = CACHE.put(request, new Response(body, {
      headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=' + ttl }
    }));
    const put2 = CACHE.put(staleKey, new Response(body, {
      headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=86400' }
    }));
    const all = Promise.all([put1, put2]).catch(() => null);
    if (ctx && ctx.waitUntil) ctx.waitUntil(all);
    else await all;
  }

  return res;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

// ---------------- 解析（与 dev-server.mjs 保持一致） ----------------

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

    const before = decoded.slice(Math.max(0, m.index - 400), m.index);
    const labels = [...before.matchAll(/"([^"]{1,20}回放)"/g)];
    const full = labels.length ? labels[labels.length - 1][1] : '回放';

    lines.push({ label: full.replace(/回放$/, '') || '回放', full, url });
  }

  const preferred = lines.findIndex((l) => /中文高清/.test(l.full));

  return { title, cover: coverM ? coverM[0] : '', lines, defaultIndex: preferred >= 0 ? preferred : 0 };
}

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

function parseRank(src, kind) {
  if (!src || src.code !== 0 || !src.data) throw new Error('排名接口返回异常');

  const tabs = (src.data.groups || []).map((group) => ({
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
      return { title: (table.headers.find((h) => h.idx === 1) || {}).name || '', headers, rows };
    })
  }));

  return { kind, tabs };
}

function parseSchedule(src, date) {
  if (!src || src.code !== 0 || !src.data) throw new Error('赛程接口返回异常');

  const list = src.data[date] || [];
  const items = [];

  for (const m of list) {
    if (!m.leftBadge || !m.rightBadge || !m.leftName || !m.rightName) continue;
    if (String(m.competitionId) !== NBA_ID) continue;

    items.push({
      mid: m.mid,
      time: String(m.startTime || '').slice(11, 16),
      startTime: m.startTime || '',
      home: { name: m.leftName, logo: m.leftBadge, score: m.leftGoal || '' },
      away: { name: m.rightName, logo: m.rightBadge, score: m.rightGoal || '' },
      desc: m.matchDesc || '',
      live: String(m.livePeriod || '0')
    });
  }

  return { date, items };
}

function parseHosts(html) {
  const hosts = {};
  for (const m of html.matchAll(/(line\d+):\s*atob\("([^"]+)"\)/g)) {
    try {
      hosts[m[1]] = atob(m[2]).replace(/\/+$/, '');
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

function absoluteLogo(src) {
  if (!src) return '';
  if (src.startsWith('//')) return 'https:' + src;
  if (src.startsWith('/')) return JRKAN + src;
  return src;
}

function parseLives(js, hosts) {
  const items = [];

  for (const raw of js.split('<ul class="item play').slice(1)) {
    const lid = (raw.match(/data-lid="([^"]+)"/) || [])[1] || '';
    const sportType = lid.split(',')[1];
    // 项目 1 足球 / 2 篮球
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

  const frame = html.match(/<iframe[^>]*class="[^"]*sub_player[^"]*"[^>]*src="([^"]+)"/);
  if (frame) add('默认线路', frame[1]);

  const score = (line) => (/高清/.test(line.label) ? 0 : /\/play\/sm\.html/.test(line.url) ? 2 : 1);
  lines.sort((a, b) => score(a) - score(b));

  return lines;
}

// ---------------- m3u8 代理（带签名） ----------------

const HLS_KEY_FALLBACK = 'liwuxie-sports-hls';

async function hmac(u, key) {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, enc.encode(u));
  return [...new Uint8Array(sig).slice(0, 12)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function proxyUrl(abs, requestUrl, key) {
  const sig = await hmac(abs, key);
  // 只返回「同源相对路径」，不写死 http/https。
  // 反代在 HTTPS 站点后面时（如 Trae/各类面板），request.url 往往是 http，
  // 拼成绝对地址就会让 m3u8 里的分片请求变成 http，被浏览器按 Mixed Content 拦掉。
  return `/api/hls?u=${encodeURIComponent(abs)}&s=${sig}`;
}

async function rewritePlaylist(text, base, requestUrl, key) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) { out.push(line); continue; }
    if (t.startsWith('#')) {
      const m = line.match(/URI="([^"]+)"/);
      if (m) {
        try {
          out.push(line.replace(/URI="([^"]+)"/, `URI="${await proxyUrl(new URL(m[1], base).toString(), requestUrl, key)}"`));
        } catch {
          out.push(line);
        }
      } else out.push(line);
      continue;
    }
    try {
      out.push(await proxyUrl(new URL(t, base).toString(), requestUrl, key));
    } catch {
      out.push(line);
    }
  }
  return out.join('\n');
}

async function handleHls(url, requestUrl, env) {
  const target = url.searchParams.get('u') || '';
  const sig = url.searchParams.get('s') || '';
  const key = (env && env.HLS_KEY) || HLS_KEY_FALLBACK;

  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return json({ error: 'u 不合法' }, 400);
  }
  if (parsed.protocol !== 'https:') return json({ error: '只允许 https' }, 403);

  // 签名校验：只转发自己下发过的地址
  const expect = await hmac(target, key);
  if (sig && sig !== expect) return json({ error: '地址未授权' }, 403);

  try {
    const res = await upstream(parsed.toString(), { referer: '', timeout: 20000 });
    const type = String(res.headers.get('content-type') || '');
    const isPlaylist = /mpegurl|m3u8/i.test(type) || /\.m3u8$/i.test(parsed.pathname);

    if (isPlaylist) {
      const body = await rewritePlaylist(await res.text(), parsed.toString(), requestUrl, key);
      return new Response(body, {
        headers: {
          ...CORS,
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Cache-Control': 'no-store'
        }
      });
    }

    return new Response(res.body, {
      headers: {
        ...CORS,
        'Content-Type': type || 'video/mp2t',
        'Cache-Control': 'public, max-age=3600'
      }
    });
  } catch (err) {
    return json({ error: '转发失败', detail: String(err.message || err) }, 502);
  }
}

// ---------------- B 站视频 / 封面（科比经典视频） ----------------

const BILI_API = 'https://api.bilibili.com';
const BILI_REF = 'https://www.bilibili.com/';
const BILI_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// B 站对机房 IP 有风控（返 412），带上像浏览器的 Cookie 能大幅降低被拦概率
const BILI_COOKIE = (function () {
  var id;
  try {
    id = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now()).replace(/-/g, '');
  } catch (err) {
    id = '0123456789abcdef' + Date.now();
  }
  return 'buvid3=' + id + 'infoc; b_nut=' + Math.floor(Date.now() / 1000);
})();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 同时最多打 2 个 B 站接口，避免 34 张封面一起冲上去直接被风控
let biliActive = 0;
const biliWait = [];

function biliSlot() {
  return new Promise((resolve) => {
    if (biliActive < 2) {
      biliActive += 1;
      resolve();
    } else {
      biliWait.push(resolve);
    }
  });
}

function biliRelease() {
  biliActive -= 1;
  const next = biliWait.shift();
  if (next) {
    biliActive += 1;
    next();
  }
}

/** BV 号 12 位，av 号纯数字 */
function isBiliId(id) {
  return /^BV[0-9A-Za-z]{10}$/.test(id) || /^av\d+$/.test(id);
}

const biliMem = new Map();

function memGet(key, ttl) {
  const hit = biliMem.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.data;
  return null;
}

function memSet(key, data) {
  if (biliMem.size > 80) biliMem.clear();
  biliMem.set(key, { at: Date.now(), data });
}

/** 带浏览器指纹的 B 站 API 请求，412/403/429 退避重试 3 次 */
async function biliGet(pathname) {
  const headers = {
    'User-Agent': BILI_UA,
    Referer: BILI_REF,
    Origin: 'https://www.bilibili.com',
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    Cookie: BILI_COOKIE
  };

  let lastStatus = 0;
  for (let i = 0; i < 3; i++) {
    await biliSlot();
    let r;
    try {
      r = await fetch(BILI_API + pathname, { headers });
    } finally {
      biliRelease();
    }
    if (r.status === 200) {
      const data = await r.json();
      if (data.code !== 0) throw new Error(data.message || 'bilibili code ' + data.code);
      return data.data;
    }
    lastStatus = r.status;
    if (r.status === 412 || r.status === 403 || r.status === 429) {
      await sleep(400 * (i + 1));
      continue;
    }
    break;
  }
  throw new Error('bilibili HTTP ' + lastStatus);
}

/** 稿件基础信息（标题 / 时长 / 封面）：内存 → Cache API → 上游，逐级兜底 */
async function biliView(id) {
  const key = 'view:' + id;
  const hit = memGet(key, 6 * 3600 * 1000);
  if (hit) return hit;

  const req = new Request('https://bili-cache.local/view/' + id);
  let view = null;

  try {
    const res = await cachedJson(
      req,
      6 * 3600,
      () =>
        biliGet(
          id.startsWith('av')
            ? `/x/web-interface/view?aid=${id.slice(2)}`
            : `/x/web-interface/view?bvid=${id}`
        ),
      {}
    );
    const parsed = await res.json();
    if (parsed && !parsed.error) view = parsed;
  } catch (err) {
    view = null;
  }

  if (!view) throw new Error('视频信息暂不可用');

  memSet(key, view);
  return view;
}

/** 可直接播放的 mp4 地址（B 站链接约 2 小时过期，短缓存） */
async function biliPlay(id) {
  const view = await biliView(id);
  const key = 'play:' + view.bvid;
  const hit = memGet(key, 20 * 60 * 1000);
  if (hit) return hit;

  const play = await biliGet(
    `/x/player/playurl?bvid=${view.bvid}&cid=${view.cid}&qn=64&fnval=0&platform=html5&high_quality=1`
  );
  const durl = (play && play.durl) || [];
  if (!durl.length) throw new Error('没有可播放片源');

  const data = { url: durl[0].url, title: view.title, duration: view.duration, cover: view.pic };
  memSet(key, data);
  return data;
}

/** 视频转发：Range 透传，浏览器/电视才能拖动进度 */
async function handleBiliVideo(request, url) {
  const id = url.searchParams.get('bv') || '';
  if (!isBiliId(id)) return json({ error: 'bv 不合法' }, 400);

  const info = await biliPlay(id);
  const headers = { 'User-Agent': UA, Referer: BILI_REF, Origin: BILI_REF };
  const range = request.headers.get('range');
  if (range) headers.Range = range;

  const up = await fetch(info.url, { headers });
  if (up.status !== 200 && up.status !== 206) {
    return json({ error: '片源不可用', detail: 'HTTP ' + up.status }, 502);
  }

  const out = {
    ...CORS,
    'Content-Type': up.headers.get('content-type') || 'video/mp4',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store'
  };
  const len = up.headers.get('content-length');
  if (len) out['Content-Length'] = len;
  const cr = up.headers.get('content-range');
  if (cr) out['Content-Range'] = cr;

  return new Response(up.body, { status: up.status, headers: out });
}

/** 接口被风控时，退一步从视频页 HTML 里抠 og:image 当封面 */
async function biliCoverFromPage(id) {
  const res = await fetch('https://www.bilibili.com/video/' + id + '/', {
    headers: {
      'User-Agent': BILI_UA,
      Referer: BILI_REF,
      'Accept-Language': 'zh-CN,zh;q=0.9',
      Accept: 'text/html,application/xhtml+xml'
    }
  });
  if (!res.ok) throw new Error('page HTTP ' + res.status);
  const html = await res.text();
  const m =
    html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
  if (!m) throw new Error('没有封面');
  return m[1].replace(/^http:/, 'https:');
}

/** 封面转发：B 站图片带防盗链，加 Referer 才取得到 */
async function handleBiliCover(url) {
  const id = url.searchParams.get('bv') || '';
  if (!isBiliId(id)) return json({ error: 'bv 不合法' }, 400);

  let pic = '';
  try {
    const view = await biliView(id);
    pic = String(view.pic || '');
  } catch (err) {
    // 接口 412（机房 IP 风控）时走页面兜底，封面别跟着一起挂
    pic = await biliCoverFromPage(id);
  }

  let p;
  try {
    p = new URL(pic);
  } catch {
    return json({ error: '没有封面' }, 404);
  }
  if (p.protocol !== 'http:' && p.protocol !== 'https:') return json({ error: '封面地址未授权' }, 403);
  if (!/(^|\.)hdslb\.com$/i.test(p.hostname)) return json({ error: '封面地址未授权' }, 403);

  // B 站封面常给 http，统一走 https 取
  const picUrl = 'https://' + p.hostname + p.pathname + p.search;

  // 封面本身也是「一张图一个请求」，缓存住能直接消掉 90% 的上游请求
  const cacheKey = new Request('https://bili-cache.local/cover/' + encodeURIComponent(picUrl));
  if (CACHE) {
    const hit = await CACHE.match(cacheKey);
    if (hit) return hit;
  }

  const up = await fetch(picUrl, {
    headers: { 'User-Agent': BILI_UA, Referer: BILI_REF, Cookie: BILI_COOKIE }
  });
  if (!up.ok) return json({ error: '封面不可用', detail: 'HTTP ' + up.status }, 404);

  const res = new Response(up.body, {
    headers: {
      ...CORS,
      'Content-Type': up.headers.get('content-type') || 'image/jpeg',
      'Cache-Control': 'public, max-age=86400'
    }
  });

  if (CACHE) {
    const copy = res.clone();
    const put = CACHE.put(cacheKey, copy).catch(() => null);
    // 边缘环境没有 waitUntil 时直接等它写完
    await put;
  }

  return res;
}

// ---------------- 路由 ----------------

async function handleApi(url, request, env, ctx) {
  if (url.pathname === '/api/kobe') {
    const force = url.searchParams.get('refresh') === '1';
    try {
      return await cachedJson(new Request(`${url.origin}/api/kobe`), force ? 1 : 1800, async () => {
        for (const src of KOBE_DATA_URLS) {
          try {
            const r = await fetch(src, {
              headers: { 'User-Agent': UA, 'Cache-Control': 'no-cache' },
              cf: { cacheTtl: 300 }
            });
            if (!r.ok) continue;
            const data = await r.json();
            if (data && Array.isArray(data.videoGroups) && data.videoGroups.length) return data;
          } catch {
            /* 换下一条线路 */
          }
        }
        // 远端都拿不到时回落到打包在站点里的默认数据
        if (env && env.ASSETS) {
          const local = await env.ASSETS.fetch(new Request(`${url.origin}/assets/data/kobe.json`));
          if (local.ok) return await local.json();
        }
        const local2 = await fetch(new URL('/assets/data/kobe.json', url.origin).toString());
        if (local2.ok) return await local2.json();
        throw new Error('科比数据不可用');
      }, { ctx, force });
    } catch (err) {
      return json({ error: '科比数据不可用', detail: String(err.message || err) }, 502);
    }
  }

  if (url.pathname === '/api/replays') {
    const category = url.searchParams.get('category') || 'basketball';
    const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
    if (!CATEGORIES[category]) return json({ error: '不支持的分类' }, 400);

    const force = url.searchParams.get('refresh') === '1';
    const cacheUrl = `${url.origin}/api/replays?category=${category}&page=${page}`;

    try {
      const body = await cachedJson(new Request(cacheUrl), force ? 1 : 600, async () => {
        const html = await fetchText(`${SITE}/replays?category=${category}&page=${page}`);
        const parsed = parseList(html);
        parsed.items = parsed.items.filter((it) => it.league === 'NBA');
        return { ...parsed, category, updatedAt: Date.now() };
      }, { ctx, force });
      return body;
    } catch (err) {
      return json({ error: '抓取失败', detail: String(err.message || err) }, 502);
    }
  }

  if (url.pathname === '/api/lives') {
    const force = url.searchParams.get('refresh') === '1';
    // 默认只回篮球，保证老版本 APK 行为不变；sport=all 一次拿全量再前端切
    const sport = url.searchParams.get('sport') || 'basketball';
    try {
      return await cachedJson(new Request(`${url.origin}/api/lives`), force ? 1 : 60, async () => {
        const data = await fetchLives();
        const all = (data.items || []).filter((it) => it.sport === 'basketball' || it.sport === 'football');
        const items = sport === 'all' ? all : all.filter((it) => (it.sport || 'basketball') === sport);
        return { ...data, items, updatedAt: Date.now() };
      }, { ctx, force });
    } catch (err) {
      return json({ error: '直播列表加载失败', detail: String(err.message || err) }, 502);
    }
  }

  if (url.pathname === '/api/live') {
    const target = url.searchParams.get('u') || '';
    let parsed;
    try {
      parsed = new URL(target);
    } catch {
      return json({ error: 'u 不合法' }, 400);
    }
    if (!/^https?:$/.test(parsed.protocol) || !/^\/play\/steam\d+\.html$/.test(parsed.pathname)) {
      return json({ error: '地址未授权' }, 403);
    }

    try {
      return await cachedJson(
        new Request(`${url.origin}/api/live?u=${encodeURIComponent(target)}`),
        120,
        async () => {
          const html = await fetchText(target, JRKAN + '/');
          return { lines: parseLiveSources(html, target), source: target, updatedAt: Date.now() };
        },
        { ctx }
      );
    } catch (err) {
      return json({ error: '直播线路解析失败', detail: String(err.message || err) }, 502);
    }
  }

  if (url.pathname === '/api/rank') {
    const kind = url.searchParams.get('kind') === 'player' ? 'player' : 'team';
    const type = kind === 'player' ? 2 : 0;
    const force = url.searchParams.get('refresh') === '1';

    try {
      return await cachedJson(new Request(`${url.origin}/api/rank?kind=${kind}`), force ? 1 : 1800, async () => {
        const body = await fetchText(
          `${QQ}/match/api/v2/statistic/rankings?competition_id=${NBA_ID}&type=${type}&scene=pc`
        );
        return { ...parseRank(JSON.parse(body), kind), updatedAt: Date.now() };
      }, { ctx, force });
    } catch (err) {
      return json({ error: '排名加载失败', detail: String(err.message || err) }, 502);
    }
  }

  if (url.pathname === '/api/schedule') {
    const date = url.searchParams.get('date') || '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: '日期不合法' }, 400);
    const force = url.searchParams.get('refresh') === '1';

    try {
      return await cachedJson(new Request(`${url.origin}/api/schedule?date=${date}`), force ? 1 : 300, async () => {
        const body = await fetchText(
          `${QQ}/matchUnion/list?columnId=${NBA_ID}&startTime=${date}&endTime=${date}&timestamp=${Date.now()}`
        );
        return { ...parseSchedule(JSON.parse(body), date), updatedAt: Date.now() };
      }, { ctx, force });
    } catch (err) {
      return json({ error: '赛程加载失败', detail: String(err.message || err) }, 502);
    }
  }

  if (url.pathname === '/api/replay') {
    const id = url.searchParams.get('id') || '';
    if (!/^\/replay\/\d+-\d+$/.test(id)) return json({ error: 'id 不合法' }, 400);

    try {
      return await cachedJson(new Request(`${url.origin}/api/replay?id=${encodeURIComponent(id)}`), 300, async () => {
        const html = await fetchText(`${SITE}${id}?source=dooqiuluxiang`);
        return { id, url: `${SITE}${id}?source=dooqiuluxiang`, ...parseDetail(html), updatedAt: Date.now() };
      }, { ctx });
    } catch (err) {
      return json({ error: '抓取失败', detail: String(err.message || err) }, 502);
    }
  }

  if (url.pathname === '/api/bili/view') {
    const id = url.searchParams.get('bv') || '';
    if (!isBiliId(id)) return json({ error: 'bv 不合法' }, 400);
    try {
      const view = await biliView(id);
      return json({
        bvid: view.bvid,
        title: view.title,
        duration: view.duration,
        cover: view.pic,
        owner: (view.owner && view.owner.name) || '',
        updatedAt: Date.now()
      });
    } catch (err) {
      return json({ error: '视频信息加载失败', detail: String(err.message || err) }, 502);
    }
  }

  if (url.pathname === '/api/bili/cover') {
    try {
      return await handleBiliCover(url);
    } catch (err) {
      return json({ error: '封面加载失败', detail: String(err.message || err) }, 502);
    }
  }

  if (url.pathname === '/api/bili/video') {
    try {
      return await handleBiliVideo(request, url);
    } catch (err) {
      return json({ error: '视频加载失败', detail: String(err.message || err) }, 502);
    }
  }

  if (url.pathname === '/api/hls') {
    return handleHls(url, request.url, env);
  }

  return json({ error: '接口不存在' }, 404);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    if (url.pathname.startsWith('/api/')) {
      try {
        return await handleApi(url, request, env, ctx);
      } catch (err) {
        return json({ error: '服务异常', detail: String((err && err.message) || err) }, 500);
      }
    }

    if (env && env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('静态资源未绑定（本地自测模式）', { status: 404 });
  }
};

export {
  parseList,
  parseTitle,
  parseDetail,
  parseRank,
  parseSchedule,
  parseLives,
  parseLiveSources,
  parseHosts
};
