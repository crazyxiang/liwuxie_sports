/*
 * 无邪体育 · 前端主逻辑
 *
 * 接口（PC 预览由 server/dev-server.mjs 提供，打包后由原生壳提供同样的接口）：
 *   GET /api/replays?category=basketball&page=1   录像列表（含分页）
 *   GET /api/replay?id=/replay/1964-1             播放线路
 *   GET /api/hls?u=<m3u8 地址>                    视频流转发
 *   GET /api/rank?kind=team|player                球队 / 球员排名
 *   GET /api/schedule?date=2026-11-17             NBA 赛程
 *   GET /api/lives                                篮球直播列表
 */
(function () {
  'use strict';

  // 打包成 App 时用 ?api=http://你的服务地址:8787 指定后端；Web 预览留空走同源
  var API_BASE = (function () {
    var m = location.search.match(/[?&]api=([^&]+)/);
    return (window.API_BASE || (m ? decodeURIComponent(m[1]) : '')).replace(/\/+$/, '');
  })();

  function api(path) {
    return API_BASE + path;
  }

  // NBA 30 支球队的中文名 → 本地队徽文件名
  var TEAM_LOGO = {
    老鹰: 'atl', 凯尔特人: 'bos', 篮网: 'bkn', 黄蜂: 'cha', 公牛: 'chi', 骑士: 'cle',
    独行侠: 'dal', 小牛: 'dal', 掘金: 'den', 活塞: 'det', 勇士: 'gs', 火箭: 'hou',
    步行者: 'ind', 快船: 'lac', 快艇: 'lac', 湖人: 'lal', 灰熊: 'mem', 热火: 'mia',
    雄鹿: 'mil', 森林狼: 'min', 鹈鹕: 'no', 尼克斯: 'ny', 雷霆: 'okc', 魔术: 'orl',
    '76人': 'phi', 太阳: 'phx', 开拓者: 'por', 国王: 'sac', 马刺: 'sa', 猛龙: 'tor',
    爵士: 'uta', 奇才: 'wsh'
  };

  // 「更多」里列出的全部球队（首屏只放热门几支）
  var ALL_TEAMS = [
    '老鹰', '凯尔特人', '篮网', '黄蜂', '公牛', '骑士', '独行侠', '掘金', '活塞', '勇士',
    '火箭', '步行者', '快船', '湖人', '灰熊', '热火', '雄鹿', '森林狼', '鹈鹕', '尼克斯',
    '雷霆', '魔术', '76人', '太阳', '开拓者', '国王', '马刺', '猛龙', '爵士', '奇才'
  ];

  var state = {
    screen: 'list',
    // 录像列表
    page: 0,
    totalPages: 1,
    items: [],
    loading: false,
    team: '',
    noCacheAll: false,
    // 排名
    rankKind: 'team',
    rankGroup: 0,
    rank: { team: null, player: null },
    rankLoading: false,
    // 赛程 / 排名（同一页两个选项卡，默认 NBA 赛程）
    date: todayStr(),
    schTab: 'schedule',
    schLoading: false,
    schLoaded: false,
    // 播放页
    detail: null,
    detailId: '',
    backHash: '#/',
    // 从播放页返回时恢复列表 / 科比页原来的滚动位置
    listY: null,
    kobeY: null,
    hls: null,
    playerFull: false,
    // 直播网页播放
    isLive: false,
    liveSource: '',
    liveTitle: '',
    liveLines: [],
    // 科比专栏
    kobe: { loaded: false, loading: false, items: [] },
    // 直播（默认选中 NBA）
    live: { loaded: false, loading: false, filter: 'NBA', items: [] },
    // 作者微信弹框
    modalOpen: false,
    // 当前打开的是哪个弹框：'author' | 'download'
    modalKind: ''
  };

  // 由方向键切菜单时，标记「焦点留在菜单上」
  var keepNavFocus = false;

  // 全屏时上一次按 OK 的时间，用于识别「双击退出全屏」
  var fullOkAt = 0;

  var el = {
    nav: document.getElementById('nav'),
    updated: document.getElementById('updated'),

    listScreen: document.getElementById('screen-list'),
    grid: document.getElementById('grid'),
    count: document.getElementById('count'),
    listTitle: document.getElementById('list-title'),
    teamFilter: document.getElementById('team-filter'),
    moreBtn: document.getElementById('more-btn'),
    morePanel: document.getElementById('more-panel'),
    refresh: document.getElementById('refresh'),
    loadMore: document.getElementById('load-more'),
    loadMoreBtn: document.getElementById('load-more-btn'),
    sentinel: document.getElementById('sentinel'),

    rankScreen: document.getElementById('screen-rank'),
    rankKind: document.getElementById('rank-kind'),
    rankGroupBox: document.getElementById('rank-group'),
    rankBody: document.getElementById('rank-body'),

    schScreen: document.getElementById('screen-schedule'),
    schTabs: document.getElementById('sch-tabs'),
    schBar: document.getElementById('sch-bar'),
    schDate: document.getElementById('sch-date'),
    schBody: document.getElementById('sch-body'),

    kobeScreen: document.getElementById('screen-kobe'),
    kobeVideos: document.getElementById('kobe-videos'),
    kobeCount: document.getElementById('kobe-count'),
    kobeNote: document.getElementById('kobe-note'),
    bgmAudio: document.getElementById('bgm-audio'),
    bgmList: document.getElementById('bgm-list'),
    bgmNow: document.getElementById('bgm-now'),

    liveScreen: document.getElementById('screen-live'),
    liveList: document.getElementById('live-list'),
    liveCount: document.getElementById('live-count'),
    liveFilter: document.getElementById('live-filter'),

    replayScreen: document.getElementById('screen-replay'),
    replayHead: document.getElementById('replay-head'),
    sources: document.getElementById('sources'),
    lines: document.getElementById('lines'),
    fullBtn: document.getElementById('full-btn'),
    playerWrap: document.getElementById('player-wrap'),
    liveFrame: document.getElementById('live-frame'),
    playerTip: document.getElementById('player-tip'),
    playerBar: document.querySelector('.player-bar'),
    pbCur: document.getElementById('pb-cur'),
    pbTotal: document.getElementById('pb-total'),
    pbFill: document.getElementById('pb-fill'),
    pbTrack: document.getElementById('pb-track'),
    pbFull: document.getElementById('pb-full'),
    video: document.getElementById('player'),
    playerState: document.getElementById('player-state'),

    authorBtn: document.querySelector('.author'),
    authorModal: document.getElementById('author-modal'),
    authorClose: document.getElementById('author-close'),

    // 下载安装包（仅网页显示）
    dlEntry: document.getElementById('dl-entry'),
    dlModal: document.getElementById('download-modal'),

    // 科比经典视频
    classics: document.getElementById('kobe-classics'),
    kcCount: document.getElementById('kc-count')
  };

  // ---------------- 工具 ----------------

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function pad2(n) {
    return ('0' + n).slice(-2);
  }

  /** 网络层失败时给一句看得懂的提示，而不是 Failed to fetch */
  function errText(err) {
    var m = err && err.message ? err.message : '';
    if (!m || /failed to fetch|networkerror|load failed/i.test(m)) {
      return '连不上数据服务：请确认服务已启动，并且电视和它在同一网络';
    }
    return m;
  }

  function todayStr() {
    var d = new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function shiftDate(str, delta) {
    var p = str.split('-');
    var d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
    d.setDate(d.getDate() + delta);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  /** 列表里的时间格式是「月/日 时:分」，用来判断是不是今天 */
  function isToday(str) {
    var d = new Date();
    return String(str || '').indexOf(pad2(d.getMonth() + 1) + '/' + pad2(d.getDate())) === 0;
  }

  /** 本地队徽优先，没有映射时退回接口给的在线地址 */
  function logoOf(name, remote) {
    var code = TEAM_LOGO[name];
    return code ? 'assets/logos/' + code + '.png' : (remote || '');
  }

  function logoTag(name, remote, cls) {
    var src = logoOf(name, remote);
    return src ? '<img class="' + (cls || 'logo') + '" src="' + esc(src) + '" alt="" loading="lazy">' : '';
  }

  function skeletons(n) {
    var html = '';
    for (var i = 0; i < n; i++) html += '<div class="skeleton"></div>';
    return html;
  }

  // ---------------- 焦点导航 ----------------

  var SCREENS = {
    list: function () { return el.listScreen; },
    live: function () { return el.liveScreen; },
    schedule: function () { return el.schScreen; },
    kobe: function () { return el.kobeScreen; },
    replay: function () { return el.replayScreen; }
  };

  function screenScope() {
    return (SCREENS[state.screen] || SCREENS.list)();
  }

  function visibleOf(list) {
    return Array.prototype.filter.call(list, function (node) {
      return node.offsetParent !== null && !node.disabled;
    });
  }

  function focusables() {
    return visibleOf(document.querySelectorAll('.topbar .focusable'))
      .concat(visibleOf(screenScope().querySelectorAll('.focusable')));
  }

  function contentFocusables() {
    return visibleOf(screenScope().querySelectorAll('.focusable'));
  }

  function topbarBottom() {
    var bar = document.querySelector('.topbar');
    return bar ? bar.getBoundingClientRect().bottom : 0;
  }

  /** 滚动时为吸顶的顶栏留出空间，避免焦点元素被挡住 */
  function ensureVisible(node) {
    var r = node.getBoundingClientRect();
    var barBottom = topbarBottom();
    // 顶栏滚出屏幕时 rect 会是负数，夹到 0，否则会把「安全区」算到页面外
    var top = (barBottom > 0 ? barBottom : 0) + 12;
    var bottom = window.innerHeight - 16;
    if (r.height > bottom - top) {
      window.scrollBy(0, r.top - top);
      return;
    }
    if (r.top < top) window.scrollBy(0, r.top - top);
    else if (r.bottom > bottom) window.scrollBy(0, r.bottom - bottom);
  }

  function setFocus(node, skipScroll) {
    var prev = document.querySelectorAll('.focused');
    for (var i = 0; i < prev.length; i++) prev[i].classList.remove('focused');
    if (!node) return;
    node.classList.add('focused');
    // 同步 DOM 焦点，电视遥控器的 OK 键才会作用到这个元素上
    try {
      node.focus({ preventScroll: true });
    } catch (err) {
      try { node.focus(); } catch (e2) { /* 忽略 */ }
    }
    if (!skipScroll) ensureVisible(node);
  }

  function currentFocus() {
    return document.querySelector('.focused');
  }

  function isTopbarNode(node) {
    return !!(node && node.closest && node.closest('.topbar'));
  }

  function canScroll(dir) {
    var max = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight) - window.innerHeight;
    return dir === 'down' ? window.pageYOffset < max - 4 : window.pageYOffset > 4;
  }

  function scrollStep(dir, ratioOverride) {
    var view = Math.max(window.innerHeight - topbarBottom(), 240);
    // 排名 / 科比是长列表，滚动步长再小一点，方便一行行慢慢看
    var ratio = ratioOverride || (state.screen === 'kobe' || (state.screen === 'schedule' && state.schTab === 'rank')
      ? 0.28
      : state.screen === 'schedule' ? 0.42 : 0.82);
    window.scrollBy(0, (dir === 'down' ? 1 : -1) * Math.round(view * ratio));
  }

  /** 焦点落到菜单 / 选项卡上就直接生效，不用再按 OK */
  function followFocus(node) {
    if (!node || !node.classList) return;
    // 只有顶部菜单是「移动即切页」；筛选、分组这类需要按 OK 确认
    if (!node.classList.contains('tab')) return;
    if (node.classList.contains('is-active')) return;
    keepNavFocus = true;
    go(node.dataset.nav);
  }

  /** 几何导航：优先同排/同列，找不到再按「主轴距离 + 副轴距离×1.8」取最近 */
  function pickInDirection(nodes, cur, dir) {
    var base = cur.getBoundingClientRect();
    var bx = base.left + base.width / 2;
    var by = base.top + base.height / 2;
    var horizontal = dir === 'left' || dir === 'right';

    function bestOf(requireOverlap) {
      var best = null;
      var bestScore = Infinity;

      for (var i = 0; i < nodes.length; i++) {
        var node = nodes[i];
        if (node === cur) continue;

        var r = node.getBoundingClientRect();
        var dx = r.left + r.width / 2 - bx;
        var dy = r.top + r.height / 2 - by;
        var main;
        var cross;

        if (dir === 'left') {
          if (dx > -6) continue;
          main = -dx;
          cross = Math.abs(dy);
        } else if (dir === 'right') {
          if (dx < 6) continue;
          main = dx;
          cross = Math.abs(dy);
        } else if (dir === 'up') {
          if (dy > -6) continue;
          main = -dy;
          cross = Math.abs(dx);
        } else {
          if (dy < 6) continue;
          main = dy;
          cross = Math.abs(dx);
        }

        // 左右移动要求纵向有交集，上下移动要求横向有交集
        var overlap = horizontal
          ? Math.min(r.bottom, base.bottom) - Math.max(r.top, base.top)
          : Math.min(r.right, base.right) - Math.max(r.left, base.left);
        if (requireOverlap && overlap <= 0) continue;

        var score = main + cross * 1.8;
        if (score < bestScore) {
          bestScore = score;
          best = node;
        }
      }

      return best;
    }

    // 左右移动到行末时换到相邻一行的第一个 / 最后一个（像真正的电视网格）
    var sameBand = bestOf(true);
    if (sameBand) return sameBand;
    if (horizontal) return wrapRow(nodes, cur, dir);
    return bestOf(false);
  }

  function wrapRow(nodes, cur, dir) {
    var base = cur.getBoundingClientRect();
    var best = null;
    var bestGap = Infinity;
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (node === cur) continue;
      var r = node.getBoundingClientRect();
      var gap = r.top - base.top;
      if (dir === 'right' ? gap < 6 : gap > -6) continue;
      gap = Math.abs(gap);
      if (gap < bestGap - 1) {
        bestGap = gap;
        best = node;
      } else if (Math.abs(gap - bestGap) <= 1 && best) {
        var br = best.getBoundingClientRect();
        if (dir === 'right' ? r.left < br.left : r.left > br.left) best = node;
      }
    }
    return best;
  }

  /** 把内容区焦点按「视觉行」分组：上下移动时一行一行走，绝不跳行、漏模块 */
  function contentRows() {
    var nodes = contentFocusables();
    if (!nodes.length) return [];

    var rects = nodes.map(function (node) {
      return { node: node, r: node.getBoundingClientRect() };
    });
    rects.sort(function (a, b) {
      if (Math.abs(a.r.top - b.r.top) > 6) return a.r.top - b.r.top;
      return a.r.left - b.r.left;
    });

    var rows = [];
    for (var i = 0; i < rects.length; i++) {
      var it = rects[i];
      var last = rows[rows.length - 1];
      if (last && Math.abs(last.top - it.r.top) <= 12) {
        last.items.push(it);
      } else {
        rows.push({ top: it.r.top, items: [it] });
      }
    }
    rows.forEach(function (row) {
      row.items.sort(function (a, b) { return a.r.left - b.r.left; });
    });
    return rows;
  }

  /** 上下移动：找当前元素所在的相邻一行，取横向最接近的那个 */
  function rowTarget(cur, dir) {
    var rows = contentRows();
    var ri = -1;
    for (var i = 0; i < rows.length && ri < 0; i++) {
      for (var j = 0; j < rows[i].items.length; j++) {
        if (rows[i].items[j].node === cur) { ri = i; break; }
      }
    }
    if (ri < 0) return null;

    var row = rows[ri + (dir === 'down' ? 1 : -1)];
    if (!row) return null;

    var base = cur.getBoundingClientRect();
    var cx = base.left + base.width / 2;
    var best = null;
    var bestScore = Infinity;
    for (var k = 0; k < row.items.length; k++) {
      var it = row.items[k];
      var rx = it.r.left + it.r.width / 2;
      // 横向距离为主；和当前元素有横向重叠的更优先，避免斜着跳
      var overlap = Math.min(it.r.right, base.right) - Math.max(it.r.left, base.left);
      var score = Math.abs(rx - cx) + (overlap > 0 ? 0 : 120);
      if (score < bestScore) {
        bestScore = score;
        best = it.node;
      }
    }
    return best;
  }

  function move(dir) {
    var cur = currentFocus();

    if (!cur || !cur.offsetParent) {
      var all = focusables();
      if (all.length) setFocus(all[0]);
      return;
    }

    // 焦点在顶栏时：左右只在菜单里走，不会掉到下面内容区
    if (isTopbarNode(cur)) {
      if (dir === 'left' || dir === 'right') {
        var tabs = visibleOf(document.querySelectorAll('.topbar .focusable'));
        var near = pickInDirection(tabs, cur, dir);
        if (near) {
          setFocus(near);
          followFocus(near);
        }
        return;
      }
      if (dir === 'up') {
        // 顶栏按上也能继续向上滚，不需要先滚到底再回来
        if (canScroll('up')) scrollStep('up');
        return;
      }

      // 下键才进入当前页面的第一个焦点
      var first = contentFocusables()[0];
      if (first) {
        var fr = first.getBoundingClientRect();
        if (fr.top < window.innerHeight - 24 && fr.bottom > topbarBottom()) {
          setFocus(first);
          return;
        }
      }
      // 第一个焦点还在屏幕外（比如科比页的视频），先往下滚，焦点留在菜单
      if (canScroll('down')) scrollStep('down');
      return;
    }

    // 排名选项卡：从「球队数据 / 球员数据」按下键，落到分组栏的第一个选项
    if (dir === 'down' && cur.classList.contains('seg-btn') && cur.closest('#rank-kind')) {
      var firstChip = el.rankGroupBox ? el.rankGroupBox.querySelector('.chip-btn') : null;
      if (firstChip && firstChip.offsetParent) {
        setFocus(firstChip);
        return;
      }
    }

    // 上下移动按视觉行一行一行走，保证每个模块都会被经过、画面跟着动
    if (dir === 'down' || dir === 'up') {
      var target = rowTarget(cur, dir);
      if (target) {
        var tr = target.getBoundingClientRect();
        // 中间隔了大段没有焦点的图文：先滚屏让用户能看到，再落焦点，避免一按就跳过整块内容
        var gap = dir === 'down' ? tr.top - window.innerHeight : -tr.bottom;
        if (gap > window.innerHeight * 0.9 && canScroll(dir)) {
          scrollStep(dir, 0.55);
          return;
        }
        setFocus(target);
        return;
      }
      if (canScroll(dir)) {
        scrollStep(dir);
        return;
      }
      // 向上到头回到菜单；向下到底就停住，不再乱跳
      if (dir === 'up') {
        var active = el.nav.querySelector('.tab.is-active') || el.nav.querySelector('.tab');
        if (active) setFocus(active);
      }
      return;
    }

    var best = pickInDirection(contentFocusables(), cur, dir);
    if (best) {
      // 左右移动仍然按几何最近：同一行里换格 / 行末换行
      setFocus(best);
      followFocus(best);
    }
  }

  function activate() {
    var node = currentFocus();
    if (node) node.click();
  }

  // ---------------- 录像列表 ----------------

  function cardHtml(it) {
    return (
      '<article class="card focusable" data-id="' + esc(it.id) + '" tabindex="-1">' +
        '<div class="cover">' +
          (it.cover ? '<img src="' + esc(it.cover) + '" alt="" loading="lazy">' : '') +
          '<span class="pill">▶ 回放</span>' +
        '</div>' +
        '<div class="card-body">' +
          '<div class="match">' +
            '<div class="side home-side">' +
              logoTag(it.home, '', 'logo') +
              '<span class="team">' + esc(it.home) + '</span>' +
            '</div>' +
            '<span class="vs">VS</span>' +
            '<div class="side away-side">' +
              logoTag(it.away, '', 'logo') +
              '<span class="team">' + esc(it.away) + '</span>' +
            '</div>' +
          '</div>' +
          '<div class="card-foot">' +
            '<span class="time">' + esc(it.time) +
              (isToday(it.time) ? '<em class="today-tag">今天</em>' : '') +
            '</span>' +
          '</div>' +
        '</div>' +
      '</article>'
    );
  }

  function visibleItems() {
    if (!state.team) return state.items;
    return state.items.filter(function (it) {
      return it.home === state.team || it.away === state.team;
    });
  }

  function hasMore() {
    return state.page < state.totalPages;
  }

  function renderList() {
    var items = visibleItems();
    var card = currentFocus();
    var keepFocus = card && card.classList && card.classList.contains('card') ? card.dataset.id : '';

    if (!items.length) {
      el.grid.innerHTML =
        '<div class="notice" style="grid-column:1/-1"><strong>' +
        (state.loading ? '加载中…' : state.team ? '暂无 ' + esc(state.team) + ' 的回放' : '暂无回放') +
        '</strong><span>' + (state.team ? '换个球队看看' : '稍后再来') + '</span></div>';
    } else {
      el.grid.innerHTML = items.map(cardHtml).join('');
    }

    el.count.textContent = state.items.length ? '共 ' + items.length + ' 场' : '';
    el.loadMore.hidden = !hasMore();

    if (keepFocus) {
      var again = el.grid.querySelector('.card[data-id="' + keepFocus.replace(/"/g, '') + '"]');
      if (again) setFocus(again);
    }
  }

  function loadNext(force, noCache) {
    if (state.loading) return;
    if (!force && !hasMore() && state.page > 0) return;

    var next = state.page + 1;
    state.loading = true;
    el.updated.textContent = '加载中…';
    if (!state.items.length) el.grid.innerHTML = skeletons(8);

    fetch(api('/api/replays?category=basketball&page=' + next + (noCache || state.noCacheAll ? '&refresh=1' : '')))
      .then(function (res) {
        return res.json().then(function (data) {
          if (data.error) throw new Error(data.detail || data.error);
          return data;
        });
      })
      .then(function (data) {
        state.page = data.page || next;
        state.totalPages = data.totalPages || 1;

        var seen = {};
        state.items.forEach(function (it) { seen[it.id] = 1; });
        (data.items || []).forEach(function (it) {
          if (!seen[it.id]) {
            seen[it.id] = 1;
            state.items.push(it);
          }
        });

        state.loading = false;
        renderList();
        if (state.page >= state.totalPages) state.noCacheAll = false;
        el.updated.textContent = '更新 ' + new Date(data.updatedAt).toLocaleTimeString('zh-CN', {
          hour: '2-digit', minute: '2-digit'
        });

        // 选了球队时把所有分页都拉完，保证筛选结果完整
        if (state.team && hasMore() && state.page < 20) loadNext();
      })
      .catch(function (err) {
        state.loading = false;
        el.updated.textContent = '—';
        el.grid.innerHTML =
          '<div class="notice" style="grid-column:1/-1"><strong>加载失败</strong><span>' +
          esc(errText(err)) + '</span>' +
          '<button class="focusable" data-action="retry">重新加载</button></div>';
      });
  }

  function setTeamFilter(team) {
    state.team = team;
    var prevFocus = currentFocus();
    var fromPanel = Boolean(prevFocus && el.morePanel.contains(prevFocus));
    var btns = document.querySelectorAll('.chip-btn[data-team]');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('is-active', btns[i].dataset.team === team);
    }
    el.morePanel.hidden = true;
    el.moreBtn.textContent = team && !el.teamFilter.querySelector('[data-team="' + team + '"]')
      ? team + ' ▾'
      : '更多 ▾';
    el.moreBtn.classList.toggle('is-active', Boolean(team) && !el.teamFilter.querySelector('[data-team="' + team + '"]'));

    renderList();
    if (state.team && hasMore() && !state.loading) loadNext();
    // 选完球队焦点留在按钮上；如果是从「更多」面板里选的，就回到「更多」按钮
    if (fromPanel) setFocus(el.moreBtn, true);
    else if (prevFocus) setFocus(prevFocus, true);
  }

  function renderMorePanel() {
    el.morePanel.innerHTML =
      '<button class="chip-btn focusable" data-team="">全部</button>' +
      ALL_TEAMS.map(function (name) {
        return '<button class="chip-btn focusable" data-team="' + esc(name) + '">' + esc(name) + '</button>';
      }).join('');
  }

  function toggleMorePanel() {
    var show = el.morePanel.hidden;
    el.morePanel.hidden = !show;
    if (show) {
      var first = el.morePanel.querySelector('.chip-btn');
      if (first) setFocus(first);
    }
  }

  // ---------------- 排名 ----------------

  function loadRank(force) {
    var kind = state.rankKind;
    if (state.rank[kind] && !force) {
      renderRank();
      return;
    }
    if (state.rankLoading) return;

    state.rankLoading = true;
    if (!state.rank[kind]) {
      el.rankGroupBox.innerHTML = '';
      el.rankBody.innerHTML = '<div class="notice"><strong>加载中…</strong></div>';
    }

    fetch(api('/api/rank?kind=' + kind + (force ? '&refresh=1' : '')))
      .then(function (res) {
        return res.json().then(function (data) {
          if (data.error) throw new Error(data.detail || data.error);
          return data;
        });
      })
      .then(function (data) {
        state.rank[kind] = data;
        state.rankGroup = 0;
        state.rankLoading = false;
        renderRank();
      })
      .catch(function (err) {
        state.rankLoading = false;
        el.rankBody.innerHTML =
          '<div class="notice"><strong>加载失败</strong><span>' + esc(errText(err)) + '</span>' +
          '<button class="focusable" data-action="retry-rank">重试</button></div>';
      });
  }

  function renderRank() {
    var data = state.rank[state.rankKind];
    if (!data) return;

    el.rankGroupBox.innerHTML = data.tabs
      .map(function (tab, i) {
        var name = String(tab.name || '').replace(/排行榜|榜$/, '');
        return (
          '<button class="chip-btn focusable' + (i === state.rankGroup ? ' is-active' : '') +
          '" data-group="' + i + '">' + esc(name) + '</button>'
        );
      })
      .join('');

    var tab = data.tabs[state.rankGroup] || data.tabs[0];
    if (!tab) {
      el.rankBody.innerHTML = '<div class="notice"><strong>暂无数据</strong></div>';
      return;
    }

    el.rankBody.innerHTML = tab.tables
      .map(function (table) {
        return (
          '<div class="rk-table">' +
            (table.title ? '<h4>' + esc(table.title) + '</h4>' : '') +
            '<table><thead><tr>' + headRow(table) + '</tr></thead>' +
            '<tbody>' + rowsHtml(table) + '</tbody></table>' +
          '</div>'
        );
      })
      .join('');
  }

  function headRow(table) {
    if (state.rankKind === 'player') {
      var last = table.headers[table.headers.length - 1] || '数据';
      return '<th>排名</th><th>球员</th><th>球队</th><th>场次</th><th>' + esc(last) + '</th>';
    }
    return '<th>排名</th><th>球队</th><th>胜</th><th>负</th><th>胜率</th><th>连胜/负</th>';
  }

  function rowsHtml(table) {
    return table.rows
      .map(function (row, i) {
        var top = i < 3 ? ' class="top"' : '';
        if (state.rankKind === 'player') {
          return (
            '<tr' + top + '>' +
              '<td>' + esc(row.rank) + '</td>' +
              '<td><div class="rk-team">' + esc(row.name) + '</div></td>' +
              '<td>' + esc(row.team) + '</td>' +
              '<td>' + esc(row.games) + '</td>' +
              '<td>' + esc(row.value) + '</td>' +
            '</tr>'
          );
        }
        return (
          '<tr' + top + '>' +
            '<td>' + esc(row.rank) + '</td>' +
            '<td><div class="rk-team">' + logoTag(row.name, row.logo, '') +
              '<span>' + esc(row.name) + '</span></div></td>' +
            '<td>' + esc(row.wins) + '</td>' +
            '<td>' + esc(row.losses) + '</td>' +
            '<td>' + esc(row.winRate) + '</td>' +
            '<td>' + esc(row.streak) + '</td>' +
          '</tr>'
        );
      })
      .join('');
  }

  function switchRankKind(kind) {
    if (kind === state.rankKind) return;
    state.rankKind = kind;
    state.rankGroup = 0;
    var btns = el.rankKind.querySelectorAll('.seg-btn');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('is-active', btns[i].dataset.kind === kind);
    }
    loadRank();
  }

  // ---------------- 赛程 ----------------

  /** 赛程页的两个选项卡：NBA 赛程 / 排名（默认赛程） */
  function applySchTab(tab) {
    state.schTab = tab === 'rank' ? 'rank' : 'schedule';
    var isRank = state.schTab === 'rank';

    if (el.schTabs) {
      var btns = el.schTabs.querySelectorAll('.seg-btn');
      for (var i = 0; i < btns.length; i++) {
        btns[i].classList.toggle('is-active', (btns[i].dataset.sch || '') === state.schTab);
      }
    }
    if (el.schBar) el.schBar.hidden = isRank;
    if (el.schBody) el.schBody.hidden = isRank;
    if (el.rankScreen) el.rankScreen.hidden = !isRank;
  }

  function loadSchedule(date, force) {
    state.date = date;
    el.schDate.value = date;
    state.schLoading = true;
    el.schBody.innerHTML = '<div class="notice"><strong>加载中…</strong></div>';

    fetch(api('/api/schedule?date=' + encodeURIComponent(date) + (force ? '&refresh=1' : '')))
      .then(function (res) {
        return res.json().then(function (data) {
          if (data.error) throw new Error(data.detail || data.error);
          return data;
        });
      })
      .then(function (data) {
        state.schLoading = false;
        state.schLoaded = true;
        renderSchedule(data.items || []);
      })
      .catch(function (err) {
        state.schLoading = false;
        el.schBody.innerHTML =
          '<div class="notice"><strong>加载失败</strong><span>' + esc(errText(err)) + '</span>' +
          '<button class="focusable" data-action="retry-sch">重试</button></div>';
      });
  }

  function renderSchedule(items) {
    if (!items.length) {
      el.schBody.innerHTML = '<div class="notice"><strong>当天没有 NBA 比赛</strong><span>换个日期看看</span></div>';
      return;
    }

    el.schBody.innerHTML = items
      .map(function (m) {
        var live = m.live === '1';
        var played = m.live === '2';
        var score = played || live
          ? esc(m.home.score || '0') + ' : ' + esc(m.away.score || '0')
          : '<span class="vs-t">VS</span>';

        var desc = String(m.desc || 'NBA').trim();
        var status = /已结束|未开始|进行中|延期|取消/.test(desc)
          ? ''
          : live ? '进行中' : played ? '已结束' : '未开始';
        var stateText = desc + (status ? ' ' + status : '');

        return (
          '<div class="sch-row">' +
            '<span class="st' + (live ? ' live' : '') + '">' +
              (live ? '进行中' : esc(m.time)) +
            '</span>' +
            '<div class="sch-team home"><span>' + esc(m.home.name) + '</span>' +
              logoTag(m.home.name, m.home.logo, '') + '</div>' +
            '<div class="sch-score">' +
              '<div class="sch-num">' + score + '</div>' +
              '<div class="sch-state">' + esc(stateText) + '</div>' +
              
            '</div>' +
            '<div class="sch-team away">' + logoTag(m.away.name, m.away.logo, '') +
              '<span>' + esc(m.away.name) + '</span></div>' +
          '</div>'
        );
      })
      .join('');
  }

  // ---------------- 直播 ----------------

  function liveRowHtml(it) {
    var title = (it.home.name || '主队') + ' VS ' + (it.away.name || '客队');
    return '<button class="live-row focusable" data-url="' + esc(it.url) + '" data-title="' + esc(title) + '">' +
      '<span class="live-time">' + esc(it.time || '待定') + '</span>' +
      '<span class="live-league">' + esc(it.league) + '</span>' +
      '<span class="live-side home">' +
        (it.home.logo ? '<img class="live-logo" src="' + esc(it.home.logo) + '" referrerpolicy="no-referrer" alt="">' : '') +
        '<b>' + esc(it.home.name || '主队') + '</b>' +
      '</span>' +
      '<span class="live-vs"><em>' + esc(it.status || 'VS') + '</em></span>' +
      '<span class="live-side away">' +
        '<b>' + esc(it.away.name || '客队') + '</b>' +
        (it.away.logo ? '<img class="live-logo" src="' + esc(it.away.logo) + '" referrerpolicy="no-referrer" alt="">' : '') +
      '</span>' +
      '<span class="live-watch">观看</span>' +
    '</button>';
  }

  /** 直播页当前的体育项目：足球 tab 独立，其他 tab 都是篮球 */
  function liveSport() {
    return state.live.filter === '足球' ? 'football' : 'basketball';
  }

  function syncLiveTitle() {
    var t = document.getElementById('live-title');
    if (!t) return;
    var f = state.live.filter;
    t.textContent = f === '足球' ? '足球直播' : '篮球直播';
  }

  function visibleLives() {
    var filter = state.live.filter;
    return state.live.items.filter(function (it) {
      var sport = it.sport || 'basketball';
      // 足球 tab：只看足球；其余 tab（含「全部」）仍然只看篮球
      if (sport === 'football') return filter === '足球';
      if (filter === '足球') return false;
      return !filter || (it.league || '').indexOf(filter) >= 0;
    });
  }

  function renderLives() {
    var items = visibleLives();
    var isFootball = state.live.filter === '足球';
    syncLiveTitle();
    el.liveCount.textContent = items.length ? '共 ' + items.length + ' 场' : '';

    if (!items.length) {
      el.liveList.innerHTML = isFootball
        ? '<div class="notice"><strong>今日暂无足球直播</strong>' +
          '<span>可明天再看，也可以切到「全部」看看今天的篮球赛事</span></div>'
        : '<div class="notice"><strong>今日暂无' + esc(state.live.filter || 'NBA') + '直播</strong>' +
          '<span>可明天再看，也可以切到「全部」看看其他篮球赛事</span></div>';
      return;
    }

    el.liveList.innerHTML = items.map(liveRowHtml).join('');
  }

  function loadLives(force) {
    if (state.live.loading) return;
    if (state.live.loaded && !force) {
      renderLives();
      return;
    }

    state.live.loading = true;
    el.liveCount.textContent = '';
    el.liveList.innerHTML =
      '<div class="notice"><strong>直播加载中…</strong><span>正在拉取最新赛程</span></div>';

    fetch(api('/api/lives?sport=all' + (force ? '&refresh=1' : '')))
      .then(function (res) {
        return res.json().then(function (data) {
          if (data.error) throw new Error(data.detail || data.error);
          return data;
        });
      })
      .then(function (data) {
        state.live.items = data.items || [];
        state.live.loaded = true;
        state.live.loading = false;
        renderLives();

        if (state.screen === 'live' && !currentFocus()) {
          var first = el.liveList.querySelector('.live-row');
          if (first) setFocus(first);
        }
      })
      .catch(function (err) {
        state.live.loading = false;
        el.liveList.innerHTML =
          '<div class="notice"><strong>直播加载失败</strong><span>' +
          esc(errText(err)) + '</span>' +
          '<button class="focusable" data-action="retry-live">重新加载</button></div>';
      });
  }

  function openLive(url, title) {
    if (!url) return;

    setPlayHash('#/live/playing');
    state.backHash = '#/live';
    state.screen = 'replay';
    state.isLive = true;
    state.liveSource = url;
    state.liveTitle = title || '篮球直播';
    pendingLiveFocus = url;
    state.liveLines = [];
    state.detail = null;
    state.detailId = '';

    el.listScreen.hidden = true;
    el.rankScreen.hidden = true;
    el.schScreen.hidden = true;
    el.kobeScreen.hidden = true;
    el.liveScreen.hidden = true;
    el.replayScreen.hidden = false;
    syncNav('live');

    el.playerWrap.classList.add('is-live');
    el.liveFrame.hidden = false;
    el.liveFrame.src = 'about:blank';
    el.playerBar.classList.remove('show');
    el.playerState.hidden = true;
    el.replayHead.innerHTML = '<h2>' + esc(state.liveTitle) + '</h2>';
    el.lines.innerHTML = '<span class="hint">正在解析直播线路…</span>';
    setPlayerFull(false);
    setFocus(el.playerWrap, true);
    showPlayerTip('按 OK 全屏观看 · 返回键退出', 3500);
    window.scrollTo(0, 0);

    fetch(api('/api/live?u=' + encodeURIComponent(url)))
      .then(function (res) {
        return res.json().then(function (data) {
          if (data.error) throw new Error(data.detail || data.error);
          return data;
        });
      })
      .then(function (data) {
        // 用户可能已经退出去了
        if (!state.isLive || state.liveSource !== url) return;
        var lines = data.lines || [];
        if (!lines.length) throw new Error('这个直播暂时没有可用线路');
        state.liveLines = lines;
        el.lines.innerHTML = lines.map(function (line, i) {
          return '<button class="line-btn focusable" data-live-line="' + i + '">' + esc(line.label) + '</button>';
        }).join('');
        playLiveLine(0);
      })
      .catch(function (err) {
        if (!state.isLive) return;
        el.lines.innerHTML =
          '<div class="notice"><strong>直播打开失败</strong><span>' + esc(errText(err)) + '</span>' +
          '<button class="focusable" data-action="retry-liveplay">重试</button></div>';
      });
  }

  function playLiveLine(i) {
    var line = state.liveLines[i];
    if (!line) return;
    var btns = el.lines.querySelectorAll('.line-btn');
    for (var k = 0; k < btns.length; k++) btns[k].classList.toggle('is-active', k === i);
    // 先清空再挂新地址，避免旧线路的声音还留着
    el.liveFrame.src = 'about:blank';
    el.liveFrame.src = line.url;
    showPlayerTip('线路：' + line.label, 2200);
  }

  /** 退出直播播放页时把 iframe 清干净，防止后台继续出声 */
  function stopLive() {
    state.isLive = false;
    state.liveLines = [];
    if (el.liveFrame) {
      el.liveFrame.hidden = true;
      el.liveFrame.src = 'about:blank';
    }
    el.playerWrap.classList.remove('is-live');
  }

  /** B 站官方播放器内嵌：本机转发失败时的兜底，仍然在本页播放，不跳外链 */
  function playKobeEmbed(bv) {
    clearKobeEmbed();
    el.video.pause();
    el.video.removeAttribute('src');
    el.playerState.hidden = true;

    var f = document.createElement('iframe');
    f.id = 'kobe-embed-frame';
    f.className = 'live-frame';
    f.setAttribute('allowfullscreen', 'true');
    f.setAttribute('scrolling', 'no');
    f.setAttribute('allow', 'autoplay; fullscreen; encrypted-media');
    f.src = 'https://player.bilibili.com/player.html?bvid=' + bv + '&autoplay=1&high_quality=1&danmaku=0';
    el.playerWrap.insertBefore(f, el.video.nextSibling);
    el.playerWrap.classList.add('is-embed');
    showPlayerTip('本机转发没成功，已切到 B 站播放器', 2600);
  }

  function clearKobeEmbed() {
    var old = document.getElementById('kobe-embed-frame');
    if (old && old.parentNode) old.parentNode.removeChild(old);
    if (el.playerWrap) el.playerWrap.classList.remove('is-embed');
  }

  // ---------------- 科比专栏 ----------------

  /** 分页扫回放列表，挑出湖人的比赛（页数据在服务端有缓存，成本很低） */
  function loadKobe(force) {
    if (state.kobe.loading) return;
    if (state.kobe.loaded && !force) {
      renderKobeVideos();
      return;
    }

    state.kobe.loading = true;
    el.kobeCount.textContent = '';
    el.kobeVideos.innerHTML = skeletons(4);

    var found = [];
    var seen = {};
    var page = 1;

    function step() {
      fetch(api('/api/replays?category=basketball&page=' + page + (force ? '&refresh=1' : '')))
        .then(function (res) {
          return res.json().then(function (data) {
            if (data.error) throw new Error(data.detail || data.error);
            return data;
          });
        })
        .then(function (data) {
          (data.items || []).forEach(function (it) {
            if (seen[it.id]) return;
            seen[it.id] = 1;
            if (it.home === '湖人' || it.away === '湖人') found.push(it);
          });

          var total = data.totalPages || 1;
          page += 1;
          // 凑够 12 场就不再往后翻，避免一次拉太多页
          if (found.length < 12 && page <= total && page <= 12) {
            step();
            return;
          }

          state.kobe.items = found.slice(0, 16);
          state.kobe.loaded = true;
          state.kobe.loading = false;
          renderKobeVideos();

          var first = el.kobeVideos.querySelector('.card');
          if (first && state.screen === 'kobe' && !currentFocus()) setFocus(first);
        })
        .catch(function (err) {
          state.kobe.loading = false;
          el.kobeVideos.innerHTML =
            '<div class="notice" style="grid-column:1/-1"><strong>加载失败</strong><span>' +
            esc(errText(err)) + '</span>' +
            '<button class="focusable" data-action="retry-kobe">重新加载</button></div>';
        });
    }

    step();
  }

  function renderKobeVideos() {
    var items = state.kobe.items;
    el.kobeCount.textContent = items.length ? '共 ' + items.length + ' 场' : '';
    el.kobeNote.hidden = !items.length;
    el.kobeNote.textContent = items.length
      ? '站内目前收录 ' + items.length + ' 场湖人比赛回放，更多比赛可到「录像」页筛选湖人查看。'
      : '';

    if (!items.length) {
      el.kobeVideos.innerHTML =
        '<div class="notice" style="grid-column:1/-1"><strong>暂时没有湖人的回放</strong><span>稍后再来看看</span></div>';
      return;
    }

    el.kobeVideos.innerHTML = items.map(cardHtml).join('');
  }

  // ---------------- 科比经典视频（B 站片源，经本机服务转发） ----------------

  var KOBE_CLASSICS = [
    {
      tag: '最后一战 · 退役战 60 分',
      items: [
        { id: 'BV1Xv8v6cEHL', title: '最后一舞：退役战 60 分全场回顾', dur: '41:24' },
        { id: 'BV1sUNW6xEVS', title: '60 分光荣退休：退役战全场集锦', dur: '27:43' },
        { id: 'BV14e411m7Xf', title: '退役战复盘：爵士真的放水了吗', dur: '19:56' },
        { id: 'BV1gPYx6GE1r', title: '赛后杨健杨毅解说：60 分谢幕', dur: '16:08' },
        { id: 'BV11A411H7ii', title: '最后一投与赛后演讲', dur: '5:16' },
        { id: 'BV15i4y1Q7Wt', title: '60 分之夜：宝刀不老', dur: '10:25' },
        { id: 'BV1anVUzgEtx', title: '退役战开场：魔术师与群星致敬', dur: '8:21' }
      ]
    },
    {
      tag: '总决赛 · 三连冠 2000-2002',
      items: [
        { id: 'BV17hHY62ES5', title: '2000 总决赛 G5 全场：步行者 33 分大胜湖人', dur: '1:42:27' },
        { id: 'BV1sM3b6SEN7', title: '2000 总决赛 G4 全集：科比加时接管', dur: '29:39' },
        { id: 'BV1a5EX6EESV', title: '2000 总决赛 G4：21 岁科比加时接管比赛', dur: '11:30' },
        { id: 'BV1ouhG6CEjS', title: '2000 G4 奥尼尔六犯离场，科比补篮准绝杀', dur: '7:30' },
        { id: 'BV1qFjS65Eut', title: '2001 总决赛 G1 全场：艾弗森 48 分破金身', dur: '1:38:05' },
        { id: 'BV1pK411A7Wg', title: '2001 总决赛全程回顾', dur: '1:27:32' },
        { id: 'BV11K4y1w7gf', title: '2001 总决赛 经典重现：艾弗森单挑 OK', dur: '59:01' },
        { id: 'BV1rRTL6KECZ', title: '2001 总决赛 G2 完整回顾：AI 燃尽 vs 巅峰 OK', dur: '1:33:09' },
        { id: 'BV1YMsW6HEN2', title: '2002 总决赛原声集锦', dur: '17:32' },
        { id: 'BV1d9sT61EWX', title: '2002 总决赛：科比表现集锦（含颁奖）', dur: '13:00' },
        { id: 'BV1GkRyYsEnL', title: 'OK 三连冠：2002 总决赛王朝之路', dur: '16:35' }
      ]
    },
    {
      tag: '总决赛 · 2009-2010 复仇',
      items: [
        { id: 'BV1xLTM6SEPZ', title: '2010 总决赛 G7：湖人绿凯抢七全纪录', dur: '49:04' },
        { id: 'BV1dtPueJEFK', title: '2010 抢七：21 世纪最激烈对决', dur: '33:28' },
        { id: 'BV1tkjE65Ey2', title: '2010 G7 上半场：科比全场被包夹', dur: '11:01' },
        { id: 'BV1ivHG6WEfB', title: '2010 总决赛全高光：复仇绿军第五冠', dur: '27:09' },
        { id: 'BV19gKJ6fEex', title: '2010 总决赛 G7 决胜时刻完整回顾', dur: '19:59' },
        { id: 'BV1Tu7S6wEy7', title: '最惨烈的冠军：2010 抢七复仇绿军', dur: '14:26' },
        { id: 'BV1dJeW6jEfY', title: '2010 总决赛 G7 湖人 vs 凯尔特人 抢七夺冠', dur: '6:25' },
        { id: 'BV1aERFYAEQP', title: '2010 抢七逆转绿军，复仇夺冠', dur: '2:45' },
        { id: 'BV1Dftd6EEGQ', title: '2009 总决赛 G5 第四节（粤语解说）', dur: '50:22' },
        { id: 'BV1Tct36JEqy', title: '2009 总决赛 G4 第一节（粤语解说）', dur: '41:04' },
        { id: 'BV19zgK6KE5u', title: '2009 总决赛高光：生涯首座 FMVP', dur: '14:40' },
        { id: 'BV1kNKU6RE2r', title: '2009 总决赛 G1：科比 40 分 8 板 8 助', dur: '15:00' }
      ]
    },
    {
      tag: '81 分之夜 · 2006',
      items: [
        { id: 'BV1U4qgBNEvb', title: '传奇 81 分：The Legend of the 81-Point Game', dur: '1:14:05' },
        { id: 'BV1R6uF67E4s', title: '黑曼巴 81 分屠龙：完整回顾', dur: '30:06' },
        { id: 'BV1eEkFBbEoV', title: '81 分屠龙夜：猛龙板凳席视角', dur: '17:33' },
        { id: 'BV1DbfSYVEj1', title: '81 分夜经典复盘', dur: '12:14' },
        { id: 'BV1zLNy6BE3T', title: '一战封神：重温 81 分屠龙神迹', dur: '27:51' },
        { id: 'BV1scEK6rEmE', title: '半场 55 分、全场 81 分的统治级表演', dur: '5:22' },
        { id: 'BV1LgfoYzEej', title: '81 分与三节 62 分的统治力', dur: '5:31' },
        { id: 'BV1QhKCzkEbZ', title: '2006 年的 8 号科比到底有多强', dur: '1:14' }
      ]
    },
    {
      tag: '高分盛宴 · 62 / 61 / 55',
      items: [
        { id: 'BV1CL8q6QEch', title: '三节 62 分屠牛：一人得分超小牛全队', dur: '32:13' },
        { id: 'BV1Q8ga6MEbP', title: '2005 年三节 62 分：极致的得分盛宴', dur: '5:52' },
        { id: 'BV1ovbv6TEgp', title: '科比和小牛的故事：三节 62 分', dur: '9:31' },
        { id: 'BV1HtbW6VEM3', title: '麦迪逊广场花园 61 分：打服纽约球迷', dur: '25:00' },
        { id: 'BV1DDTd6cE1w', title: '61 分封神战：客场高呼 MVP', dur: '12:03' },
        { id: 'BV19MbE6DEXb', title: '最后一次乔科大战：55 分 9 记三分', dur: '14:52' },
        { id: 'BV1Uitu62ErX', title: '03 年对阵奇才：55 分全场精彩时刻', dur: '4:47' },
        { id: 'BV1qWuz6aEcr', title: '单节 30 分、三节 52 分打爆西部第一爵士', dur: '3:31' }
      ]
    },
    {
      tag: '连续 4 场 50+ · 12 记三分',
      items: [
        { id: 'BV16Yy4z6EsS', title: '连续 4 场 50+ 第一场：65 分打开序幕', dur: '40:38' },
        { id: 'BV1YzYx67EW3', title: '连续 4 场 50+：65 分只是开始', dur: '11:35' },
        { id: 'BV1VJHn6iEvj', title: '65 分开启连续 4 场 50+ 神迹', dur: '16:00' },
        { id: 'BV1XsWU6XE77', title: '对开拓者 65 分（第一场）集锦', dur: '9:42' },
        { id: 'BV1thtN6vELd', title: '单场 12 记三分：45 分射落超音速', dur: '7:33' },
        { id: 'BV148pm6qEEs', title: '12 记三分单场纪录', dur: '2:29' },
        { id: 'BV1Ypgu6yESE', title: '95 秒 3 记三分，13 年绝境三连击又是猛龙', dur: '8:10' }
      ]
    },
    {
      tag: '绝杀与名场面',
      items: [
        { id: 'BV1t5Nr6kEih', title: '季后赛双绝杀太阳：决胜时刻全记录', dur: '30:32' },
        { id: 'BV14z9MBTEBv', title: 'NBA 历史首个双绝杀', dur: '2:43' },
        { id: 'BV1wzYe6nEyW', title: '漂移三分绝杀热火：科比 33 分 vs 韦德 26 分', dur: '30:50' },
        { id: 'BV1To9MYLE63', title: '0.3 秒绝杀：全世界都知道他要投', dur: '1:59' },
        { id: 'BV1X3hJ6sEL7', title: '2009 湖人 vs 热火：打板绝杀全程', dur: '47:58' },
        { id: 'BV1nVMg6XEkY', title: '0.4 秒史诗绝杀：09 科韦之战', dur: '19:12' },
        { id: 'BV174xH6sEum', title: 'NBA 史上最残暴隔扣合集', dur: '9:56' },
        { id: 'BV1zotu6AEMd', title: '科比生涯隔扣集锦', dur: '9:04' },
        { id: 'BV1V841147xF', title: '生涯 35 次绝杀全记录', dur: '2:25' },
        { id: 'BV1WT421v7q9', title: '2006 首轮 G4：双绝杀太阳的背后', dur: '1:40' },
        { id: 'BV15F411z7Jb', title: '经典绝杀系列：双绝杀太阳', dur: '0:49' }
      ]
    },
    {
      tag: '生涯集锦 · 百佳球',
      items: [
        { id: 'BV1UU3y6qErK', title: '从 8 号到 24 号：生涯 40 佳球', dur: '10:55' },
        { id: 'BV1ZVLQ6JE72', title: '曼巴记忆：生涯十佳球', dur: '3:00' },
        { id: 'BV1aSgH6yE59', title: '8 号是暴力美学，24 号是技术大成：十佳球', dur: '6:43' },
        { id: 'BV1BYNE6cEjx', title: '40 大实战扣篮：美如画不止跳投', dur: '8:35' },
        { id: 'BV1z4411u7n7', title: '回顾老大美如画的后仰跳投', dur: '8:14' },
        { id: 'BV1RnpM6gENN', title: '沉浸式欣赏科比招牌后仰', dur: '7:37' },
        { id: 'BV1bXVL6FE53', title: '乔丹 & 科比后仰跳投混剪', dur: '6:01' },
        { id: 'BV1aB4y1N7fL', title: '科比的过人技术', dur: '3:00' },
        { id: 'BV14Un16fEq6', title: '史上最顶级的单打球手', dur: '14:21' }
      ]
    },
    {
      tag: '中国行',
      items: [
        { id: 'BV1r7411673K', title: '开讲啦：科比讲述黑曼巴精神（完整）', dur: '44:29' },
        { id: 'BV1tV4y1C71Y', title: '开讲啦：黑曼巴的由来', dur: '2:49' },
        { id: 'BV1rV4y1C7YB', title: '开讲啦：杰伦唱歌比打球好', dur: '2:01' },
        { id: 'BV1yJ411371p', title: '中国行和路人单挑：祭出 60% 功力', dur: '3:45' },
        { id: 'BV1SW4y137fW', title: '中国行人气：万人空巷', dur: '2:49' },
        { id: 'BV1f5411d72R', title: '上海行与球迷单挑（原声高清）', dur: '2:04' },
        { id: 'BV1Mo4y1P7Z7', title: '亚洲行中国台湾省见面会', dur: '52:58' },
        { id: 'BV13s411v7pB', title: '星球者联盟发布会：退役后中国首秀', dur: '42:15' },
        { id: 'BV14741167Ls', title: '对中国球迷说：新年快乐，我爱你们', dur: '2:28' }
      ]
    },
    {
      tag: '篮球公园 · 央视镜头',
      items: [
        { id: 'BV1mt411S7iw', title: '篮球公园：张卫平专访科比', dur: '7:01' },
        { id: 'BV1Et4y1G7Tn', title: '2007 篮球公园：科比交易？最后的 OK 组合', dur: '4:09' },
        { id: 'BV1HT411R7jV', title: '篮球公园：科比教你篮球绝招', dur: '8:42' }
      ]
    },
    {
      tag: '纪录片 · 专访',
      items: [
        { id: 'BV1MeGh6eEPM', title: '科比的缪斯 Kobe Bryant\'s Muse（中文字幕 1080P 完整版）', dur: '2:23:50' },
        { id: 'BV14p4y197Hp', title: '科比生涯纪录片《Muse》', dur: '1:23:09' },
        { id: 'BV1V7411h7Hs', title: '科比的一天 Kobe Doin\' Work（斯派克·李）', dur: '1:31:03' },
        { id: 'BV1SAK5efEoN', title: '曼巴三部曲（二）：从小飞侠到黑曼巴', dur: '27:41' },
        { id: 'BV1T1Jj6LER5', title: '科比生涯纪录片全集（下）', dur: '19:19' },
        { id: 'BV1cqYVz3EDG', title: '黑曼巴十年五冠封神巅峰', dur: '11:58' },
        { id: 'BV1HD4y1X7pv', title: '科比生涯最励志的一段采访', dur: '33:51' },
        { id: 'BV1bs411W78y', title: '科比 TED 演讲：意志的力量', dur: '42:08' },
        { id: 'BV1No4y1R7mb', title: '跟腱断裂后的采访：眼眶泛泪', dur: '7:04' },
        { id: 'BV1YYsbzSER6', title: '跟腱断裂仍坚持罚球', dur: '5:04' }
      ]
    },
    {
      tag: '退役演讲 · 球衣退役 · 奥斯卡',
      items: [
        { id: 'BV18PQeBuEVp', title: '科比退役演讲', dur: '3:01' },
        { id: 'BV1f54y1s7xT', title: '球衣退役全程（中文回顾）', dur: '15:28' },
        { id: 'BV194rYYZEjs', title: '球衣退役仪式演讲（中英字幕）', dur: '14:15' },
        { id: 'BV1yu411r7SF', title: '球衣退役演讲：梦想不是终点', dur: '4:06' },
        { id: 'BV1mW411x7p9', title: '奥斯卡最佳短片《亲爱的篮球》+ 获奖感言', dur: '13:55' },
        { id: 'BV1gE411Z7GX', title: '亲爱的篮球完整版', dur: '5:23' },
        { id: 'BV15x4y1174u', title: '雕像揭幕：菲尔·杰克逊致辞', dur: '11:01' }
      ]
    },
    {
      tag: '经典比赛',
      items: [
        { id: 'BV18nMF6MEpm', title: '2008 西决：20 分大逆转马刺', dur: '39:43' },
        { id: 'BV1tCNx6qES3', title: '2010 湖人 vs 骑士全场回放', dur: '1:09:03' },
        { id: 'BV1q7Hf6HEma', title: '2009 湖人 vs 骑士全场解说', dur: '53:46' }
      ]
    },
    {
      tag: '全明星 · 奥运 · 圣诞',
      items: [
        { id: 'BV1UF411y7n7', title: '2008 北京奥运男篮决赛：美国 vs 西班牙', dur: '2:12:26' },
        { id: 'BV1uyuu6qEmm', title: '2012 全明星最后决胜阶段', dur: '4:45' },
        { id: 'BV18Utb6gE9E', title: '2001 全明星全场精彩时刻', dur: '9:42' },
        { id: 'BV1d1bT6dEdx', title: '2013 全明星全场精彩时刻', dur: '8:32' }
      ]
    }
  ];

  function renderKobeClassics() {
    if (!el.classics) return;
    var total = 0;
    el.classics.innerHTML = KOBE_CLASSICS.map(function (group) {
      total += group.items.length;
      return '<div class="kc-group"><h4>' + esc(group.tag) + '</h4><div class="kc-grid">' +
        group.items.map(function (it) {
          return '<article class="kv-card focusable" tabindex="-1" data-bv="' + esc(it.id) + '" data-title="' + esc(it.title) + '">' +
            '<img loading="lazy" alt="" data-stage="0" src="assets/kobe/covers/' + esc(it.id) + '.jpg">' +
            '<span class="kv-dur">' + esc(it.dur) + '</span>' +
            '<span class="kv-play">▶</span>' +
            '<div class="kv-body"><div class="kv-title">' + esc(it.title) + '</div></div>' +
            '</article>';
        }).join('') +
        '</div></div>';
    }).join('');
    if (el.kcCount) el.kcCount.textContent = total + ' 个视频';

    // 封面兜底：本地封面 → 线上代理 → 占位块，避免线上 B 站接口 502 出现破图
    var imgs = el.classics.querySelectorAll('.kv-card img');
    Array.prototype.forEach.call(imgs, function (img) {
      img.addEventListener('error', function () {
        var card = img.closest ? img.closest('.kv-card') : null;
        var bv = card ? card.getAttribute('data-bv') : '';
        var stage = img.getAttribute('data-stage') || '0';

        if (stage === '0' && bv) {
          img.setAttribute('data-stage', '1');
          setTimeout(function () {
            img.src = api('/api/bili/cover?bv=' + bv);
          }, 600);
          return;
        }

        var fb = document.createElement('div');
        fb.className = 'kv-thumb-fallback';
        fb.textContent = '封面暂不可用';
        if (img.parentNode) img.parentNode.replaceChild(fb, img);
      });
    });
  }

  /** 在本页播放器里直接打开 B 站视频（视频流由本机服务转发，不跳外链） */
  function openKobeVideo(bv, title) {
    clearKobeEmbed();
    if (state.screen === 'kobe') state.kobeY = window.pageYOffset;
    setPlayHash('#/play/' + bv);
    state.backHash = '#/kobe';
    state.screen = 'replay';
    state.detailId = 'kobe-' + bv;
    stopLive();

    el.listScreen.hidden = true;
    el.rankScreen.hidden = true;
    el.schScreen.hidden = true;
    el.kobeScreen.hidden = true;
    el.liveScreen.hidden = true;
    el.replayScreen.hidden = false;
    syncNav('');

    el.replayHead.innerHTML =
      '<h2>' + esc(title) + '</h2>' +
      '<p class="replay-sub">科比经典视频 · 片源来自 B 站，由本机服务转发</p>';
    el.lines.innerHTML = '';
    el.playerState.hidden = false;
    el.playerState.textContent = '加载中…';
    el.pbCur.textContent = '00:00';
    el.pbTotal.textContent = '--:--';
    el.pbFill.style.width = '0%';
    setPlayerFull(false);
    // 经典视频不做断点续播，每次都从头看
    resumeApplied = true;
    if (el.playerBar) el.playerBar.classList.remove('show');
    setFocus(el.playerWrap, true);
    showPlayerTip('按 OK 全屏播放', 2600);
    window.scrollTo(0, 0);

    // 关掉 BGM，别和视频声音叠在一起
    stopKobeBgm();

    if (state.hls) {
      state.hls.destroy();
      state.hls = null;
    }

    // 封面优先用本地包里的图，线上接口挂了也不影响播放页
    el.video.poster = 'assets/kobe/covers/' + bv + '.jpg';
    el.video.preload = 'auto';
    el.video.src = api('/api/bili/video?bv=' + bv);

    el.video.onloadeddata = function () {
      el.playerState.hidden = true;
      syncProgress();
    };
    el.video.onerror = function () {
      if (state.detailId !== 'kobe-' + bv) return;
      el.playerState.hidden = false;
      if (!inNativeShell()) {
        el.playerState.textContent = '本机转发没取到片源，正在切 B 站播放器…';
        setTimeout(function () {
          if (state.detailId === 'kobe-' + bv && state.screen === 'replay') playKobeEmbed(bv);
        }, 900);
        return;
      }
      el.playerState.textContent = '视频加载失败，返回重新选一个';
    };

    var p = el.video.play();
    if (p && p.catch) p.catch(function () {});
  }

  // ---------------- 科比专属 BGM ----------------

  var KOBE_BGM = [
    { name: 'Because of You', file: 'assets/kobe/Because of You.mp3' },
    { name: 'Dancing With Your Ghost', file: 'assets/kobe/Dancing With Your Ghost.mp3' },
    { name: 'See You Again', file: 'assets/kobe/See You Again.mp3?v=2' }
  ];
  var bgm = { idx: -1, want: false };

  function renderBgm() {
    if (!el.bgmList) return;
    el.bgmList.innerHTML = KOBE_BGM.map(function (track, i) {
      return '<button class="bgm-btn focusable" data-bgm="' + i + '">♪ ' + esc(track.name) + '</button>';
    }).join('');
  }

  function syncBgmUI() {
    if (!el.bgmList) return;
    var btns = el.bgmList.querySelectorAll('.bgm-btn');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('is-playing', bgm.want && Number(btns[i].dataset.bgm) === bgm.idx);
    }
    if (el.bgmNow) {
      el.bgmNow.textContent = bgm.want && bgm.idx >= 0
        ? (el.bgmAudio.paused ? '按 OK 播放' : '正在播放：' + KOBE_BGM[bgm.idx].name)
        : '';
    }
  }

  function playBgm(i) {
    if (!el.bgmAudio || !KOBE_BGM[i]) return;
    bgm.idx = i;
    bgm.want = true;
    var src = encodeURI(KOBE_BGM[i].file);
    if (el.bgmAudio.getAttribute('src') !== src) el.bgmAudio.setAttribute('src', src);
    var p = el.bgmAudio.play();
    // 浏览器会拦自动播放，TV WebView 允许；被拦时焦点按 OK 或点一下按钮即可
    if (p && p.catch) p.catch(function () { syncBgmUI(); });
    syncBgmUI();
  }

  /** 进入科比页随机放一首 */
  function startKobeBgm() {
    playBgm(Math.floor(Math.random() * KOBE_BGM.length));
  }

  function stopKobeBgm() {
    if (!el.bgmAudio) return;
    bgm.want = false;
    bgm.idx = -1;
    el.bgmAudio.pause();
    // 没加载过音源时部分 WebView 直接改 currentTime 会报错
    try { el.bgmAudio.currentTime = 0; } catch (err) { /* 忽略 */ }
    syncBgmUI();
  }

  // ---------------- 播放页 ----------------

  function destroyPlayer() {
    saveResume();
    stopLive();
    if (state.hls) {
      state.hls.destroy();
      state.hls = null;
    }
    el.video.pause();
    el.video.removeAttribute('src');
    el.video.load();
  }

  function playLine(index) {
    if (!state.detail || !state.detail.lines[index]) return;

    var line = state.detail.lines[index];
    var src = api('/api/hls?u=' + encodeURIComponent(line.url));

    var btns = el.lines.querySelectorAll('.line-btn');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('is-active', Number(btns[i].dataset.line) === index);
    }

    el.playerState.hidden = false;
    el.playerState.textContent = '加载中…';
    el.video.poster = state.detail.cover || '';
    el.video.preload = 'auto';

    if (state.hls) {
      state.hls.destroy();
      state.hls = null;
    }

    if (window.Hls && window.Hls.isSupported()) {
      var hls = new window.Hls({
        maxBufferLength: 60,
        maxMaxBufferLength: 120,
        backBufferLength: 30,
        enableWorker: true
      });
      hls.loadSource(src);
      hls.attachMedia(el.video);
      hls.on(window.Hls.Events.MANIFEST_PARSED, function () {
        el.playerState.hidden = true;
        el.video.play().catch(function () {});
      });
      hls.on(window.Hls.Events.ERROR, function (evt, data) {
        if (data && data.fatal) {
          el.playerState.hidden = false;
          el.playerState.textContent = '播放失败，试试切换线路';
        }
      });
      state.hls = hls;
    } else {
      el.video.src = src;
      el.video.play().catch(function () {});
    }
  }

  // ---------------- 播放器：放大 / 播放控制 ----------------

  var tipTimer = null;

  function showPlayerTip(text, holdMs) {
    if (!el.playerTip) return;
    clearTimeout(tipTimer);
    el.playerTip.textContent = text;
    el.playerTip.classList.add('show');
    tipTimer = setTimeout(hidePlayerTip, holdMs || 1400);
  }

  function hidePlayerTip() {
    clearTimeout(tipTimer);
    if (!el.playerTip) return;
    el.playerTip.classList.remove('show');
  }

  /** 浏览器 / WebView 支持时同时进入原生全屏，不支持则用 CSS 全屏兜底 */
  function nativeFull(on) {
    var root = document.documentElement;
    try {
      if (on) {
        if (root.requestFullscreen) root.requestFullscreen().catch(function () {});
        else if (root.webkitRequestFullscreen) root.webkitRequestFullscreen();
      } else if (document.exitFullscreen && document.fullscreenElement) {
        document.exitFullscreen();
      } else if (document.webkitExitFullscreen && document.webkitFullscreenElement) {
        document.webkitExitFullscreen();
      }
    } catch (err) {
      /* 忽略：CSS 全屏已经生效 */
    }
  }

  function setPlayerFull(full) {
    state.playerFull = full;
    el.playerWrap.classList.toggle('is-full', full);
    document.body.classList.toggle('player-full', full);
    if (el.fullBtn) {
      el.fullBtn.textContent = full ? '退出全屏' : '全屏播放';
      el.fullBtn.classList.toggle('is-active', full);
    }
    if (full) {
      nativeFull(true);
      var web = document.body.classList.contains('is-web');
      showPlayerTip(
        state.isLive
          ? '返回键退出全屏'
          : web
          ? '单击暂停 / 播放 · 快速双击退出全屏 · 点进度条跳转'
          : 'OK 暂停/播放 · 长按 ← → 快退/快进 · 返回键缩小',
        3500
      );
    } else {
      seekStop();
      nativeFull(false);
      hidePlayerTip();
    }
  }

  function enterPlayerFull() {
    setPlayerFull(true);
    if (!state.isLive) el.video.play().catch(function () {});
    setFocus(el.playerWrap, true);
  }

  function exitPlayerFull() {
    if (!state.playerFull) return;
    lastExitFullAt = Date.now();
    setPlayerFull(false);
    setFocus(el.playerWrap);
  }

  var lastExitFullAt = 0;

  // 长按左右键连续快退 / 快进：1× → 2× → 3× 逐级加速，松手停止
  var seekHold = { timer: null, dir: 0, start: 0, alive: 0 };

  function seekStop() {
    var holding = !!seekHold.timer;
    if (seekHold.timer) clearInterval(seekHold.timer);
    seekHold.timer = null;
    seekHold.dir = 0;
    seekHold.alive = 0;
    if (holding) showBar(1800);
  }

  function seekStart(dir) {
    // 同一方向按住不放：只续期，不重来
    if (seekHold.timer && seekHold.dir === dir) {
      seekAlive();
      return;
    }
    seekStop();
    seekHold.dir = dir;
    seekHold.start = Date.now();
    seekHold.alive = Date.now() + 1500;
    showBar(0);
    // 起手先走一步，短按一次就是 15 秒
    seekBy(dir === 'right' ? 15 : -15);
    seekHold.timer = setInterval(function () {
      if (Date.now() > seekHold.alive) {
        seekStop();
        return;
      }
      // 按住时间越长倍速越高：1× → 2× → 3×（每 200ms 走一档）
      var held = Date.now() - seekHold.start;
      var rate = held > 3000 ? 3 : held > 1500 ? 2 : 1;
      seekBy((dir === 'right' ? 1 : -1) * 8 * rate);
      showPlayerTip((dir === 'right' ? '快进 ×' : '快退 ×') + rate, 1400);
    }, 200);
  }

  /** 按键重复事件里续期，松手 1.5 秒后自动停 */
  function seekAlive() {
    if (seekHold.timer) seekHold.alive = Date.now() + 1500;
  }

  function togglePlay() {
    if (el.video.paused) {
      el.video.play().catch(function () {});
      showPlayerTip('播放', 1200);
    } else {
      el.video.pause();
      showPlayerTip('已暂停', 1200);
    }
  }

  function seekBy(sec) {
    var dur = el.video.duration || 0;
    var to = el.video.currentTime + sec;
    if (dur) to = Math.min(to, dur - 0.5);
    el.video.currentTime = Math.max(0, to);
    showPlayerTip((sec > 0 ? '快进 ' : '快退 ') + Math.abs(sec) + ' 秒', 1200);
    syncProgress();
    showBar(2200);
  }

  // ---------------- 播放进度条 ----------------

  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    var h = Math.floor(sec / 3600);
    var m = Math.floor((sec % 3600) / 60);
    var s = sec % 60;
    return (h ? h + ':' + pad2(m) : m) + ':' + pad2(s);
  }

  function syncProgress() {
    if (!el.pbCur) return;
    var cur = el.video.currentTime || 0;
    var dur = el.video.duration;
    el.pbCur.textContent = fmtTime(cur);
    el.pbTotal.textContent = isFinite(dur) && dur > 0 ? fmtTime(dur) : '--:--';
    el.pbFill.style.width =
      isFinite(dur) && dur > 0 ? Math.min(100, (cur / dur) * 100) + '%' : '0%';
  }

  /** 进度条：正常播放时自动隐藏，暂停 / 快进快退时才显示 */
  var barTimer = null;

  function showBar(holdMs) {
    if (!el.playerBar) return;
    clearTimeout(barTimer);
    barTimer = null;
    el.playerBar.classList.add('show');
    if (holdMs > 0) barTimer = setTimeout(hideBar, holdMs);
  }

  function hideBar() {
    clearTimeout(barTimer);
    barTimer = null;
    if (!el.playerBar) return;
    // 暂停、拖动和长按快进过程中保持可见
    if (el.video.paused || el.video.seeking || seekHold.timer) return;
    el.playerBar.classList.remove('show');
  }

  // ---------------- 断点续播 ----------------

  var RESUME_PREFIX = 'wx_pos_';
  var RESUME_TTL = 7 * 24 * 3600 * 1000;
  var resumeApplied = false;
  var lastResumeSave = 0;

  function resumeKey() {
    return RESUME_PREFIX + state.detailId;
  }

  function saveResume() {
    if (!state.detailId) return;
    var dur = el.video.duration;
    var cur = el.video.currentTime || 0;
    if (!isFinite(dur) || dur <= 0) return;
    try {
      // 刚开头或已经快看完的不记录，避免下次「续播」反而从头错过结尾
      if (cur < 5 || cur > dur - 15) {
        localStorage.removeItem(resumeKey());
        return;
      }
      localStorage.setItem(resumeKey(), JSON.stringify({ t: Math.floor(cur), at: Date.now() }));
    } catch (err) {
      /* 隐私模式 / 存储已满时忽略 */
    }
  }

  function readResume() {
    try {
      var raw = localStorage.getItem(resumeKey());
      if (!raw) return 0;
      var obj = JSON.parse(raw);
      if (!obj || !(obj.t > 0)) return 0;
      if (Date.now() - (obj.at || 0) > RESUME_TTL) return 0;
      return obj.t;
    } catch (err) {
      return 0;
    }
  }

  function clearResume() {
    try {
      localStorage.removeItem(resumeKey());
    } catch (err) {
      /* 忽略 */
    }
  }

  function applyResume() {
    if (resumeApplied) return;
    var dur = el.video.duration;
    if (!isFinite(dur) || dur <= 0) return;
    resumeApplied = true;
    var t = readResume();
    if (t < 5 || t > dur - 15) return;
    try {
      el.video.currentTime = t;
    } catch (err) {
      return;
    }
    syncProgress();
    showPlayerTip('接着上次 ' + fmtTime(t) + ' 继续播放', 2600);
  }

  /** 播放页也进历史记录：网页/手机浏览器返回键能直接回到进入前的页面 */
  function setPlayHash(hash) {
    if ((location.hash || '') === hash) return;
    skipNextHashRoute = true;
    location.hash = hash;
  }

  function showReplay(id) {
    var entering = state.screen !== 'replay';
    state.backHash = state.screen === 'kobe'
      ? '#/kobe'
      : state.screen === 'replay' ? state.backHash : '#/';
    if (entering && state.screen === 'list') state.listY = window.pageYOffset;
    if (entering && location.hash.indexOf('#/replay/') !== 0) {
      setPlayHash('#/replay/' + encodeURIComponent(id));
    }
    state.screen = 'replay';
    state.detailId = id;
    stopLive();
    clearKobeEmbed();
    el.listScreen.hidden = true;
    el.rankScreen.hidden = true;
    el.schScreen.hidden = true;
    el.kobeScreen.hidden = true;
    el.liveScreen.hidden = true;
    el.replayScreen.hidden = false;
    syncNav('');

    el.replayHead.innerHTML = '<div class="skeleton" style="height:80px"></div>';
    el.lines.innerHTML = '';
    el.playerState.hidden = false;
    el.playerState.textContent = '加载中…';
    el.pbCur.textContent = '00:00';
    el.pbTotal.textContent = '--:--';
    el.pbFill.style.width = '0%';
    setPlayerFull(false);
    // 重新进详情页：允许按本视频的已存进度恢复一次
    resumeApplied = false;
    lastResumeSave = 0;
    if (el.playerBar) el.playerBar.classList.remove('show');
    setFocus(el.playerWrap, true);
    showPlayerTip('按 OK 全屏播放', 2600);
    window.scrollTo(0, 0);

    fetch(api('/api/replay?id=' + encodeURIComponent(id)))
      .then(function (res) {
        return res.json().then(function (data) {
          if (data.error) throw new Error(data.detail || data.error);
          return data;
        });
      })
      .then(function (data) {
        state.detail = data;
        renderDetail(data);
        if (data.lines && data.lines.length) playLine(data.defaultIndex || 0);
        else el.playerState.textContent = '没有可用线路';
      })
      .catch(function (err) {
        el.replayHead.innerHTML = '';
        el.lines.innerHTML =
          '<div class="notice"><strong>打开失败</strong><span>' + esc(errText(err)) + '</span>' +
          '<button class="focusable" data-action="retry-replay">重试</button></div>';
        el.playerState.textContent = '加载失败';
      });
  }

  function renderDetail(data) {
    el.replayHead.innerHTML =
      '<h2>' + esc(data.title || '赛事回放') + '</h2>';

    el.lines.innerHTML = data.lines && data.lines.length
      ? data.lines.map(function (line, i) {
          return '<button class="line-btn focusable" data-line="' + i + '">' + esc(line.label) + '</button>';
        }).join('')
      : '<div class="notice"><strong>暂无播放线路</strong></div>';
  }

  // ---------------- 页面切换 ----------------

  function syncNav(nav) {
    var btns = el.nav.querySelectorAll('.tab');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('is-active', btns[i].dataset.nav === nav);
    }
  }

  function showScreen(name) {
    if (state.screen === 'replay' && name !== 'replay') {
      exitPlayerFull();
      destroyPlayer();
    }
    state.screen = name;
    el.listScreen.hidden = name !== 'list';
    el.liveScreen.hidden = name !== 'live';
    el.rankScreen.hidden = true;
    el.schScreen.hidden = name !== 'schedule';
    el.kobeScreen.hidden = name !== 'kobe';
    el.replayScreen.hidden = true;
    if (name === 'schedule') applySchTab(state.schTab);
    syncNav(name);
    window.scrollTo(0, 0);

    // 科比页随机播放专属 BGM，离开就停
    if (name === 'kobe') startKobeBgm();
    else stopKobeBgm();

    // 方向键移动菜单时直接切页面，但焦点要留在菜单上
    if (keepNavFocus) {
      keepNavFocus = false;
      var activeTab = el.nav.querySelector('.tab.is-active');
      if (activeTab) setFocus(activeTab, true);
      return;
    }

    var scope = SCREENS[name]();

    // 从直播播放页返回时，焦点回到刚才那一场比赛
    if (name === 'live' && pendingLiveFocus) {
      var backUrl = pendingLiveFocus;
      pendingLiveFocus = '';
      // 直播间列表会在 route 里重新渲染一次，等它渲染完再聚焦
      setTimeout(function () {
        if (state.screen === 'live') focusLiveRow(backUrl);
      }, 0);
      return;
    }

    // 直播页默认聚焦当前选中的联赛（默认 NBA）
    var first = name === 'live'
      ? scope.querySelector('.chip-btn.is-active') || scope.querySelector('.focusable')
      : scope.querySelector('.focusable');

    if (first) {
      // 第一个焦点在屏幕外（科比页视频在很下面）时，焦点留在菜单，靠下键逐屏滚动
      if (first.getBoundingClientRect().top > window.innerHeight - 40) {
        var tab = el.nav.querySelector('.tab.is-active');
        if (tab) {
          setFocus(tab, true);
          return;
        }
      }
      setFocus(first);
    }
  }

  /** 直播列表重渲染后，按地址把焦点还回那场比赛 */
  function focusLiveRow(url) {
    var rows = el.liveList.querySelectorAll('.live-row');
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].dataset.url === url) {
        setFocus(rows[i]);
        return;
      }
    }
    var tab = el.nav.querySelector('.tab.is-active');
    if (tab) setFocus(tab, true);
  }

  function refreshCurrent() {
    if (state.screen === 'list') {
      state.page = 0;
      state.items = [];
      state.noCacheAll = true;
      loadNext(true, true);
    } else if (state.screen === 'live') {
      loadLives(true);
    } else if (state.screen === 'schedule') {
      if (state.schTab === 'rank') {
        state.rank[state.rankKind] = null;
        loadRank(true);
      } else {
        loadSchedule(state.date, true);
      }
    } else if (state.screen === 'kobe') {
      loadKobe(true);
    } else if (state.screen === 'replay') {
      if (state.isLive) openLive(state.liveSource, state.liveTitle);
      else showReplay(state.detailId);
    }
  }

  function go(nav) {
    var hash = nav === 'list' ? '#/' : '#/' + nav;
    if (location.hash === hash) return;
    // 立即切页，不等浏览器异步的 hashchange，菜单高亮更跟手
    skipNextHashRoute = true;
    location.hash = hash;
    route();
  }

  var skipNextHashRoute = false;
  // 从直播播放页返回时要恢复焦点的比赛地址
  var pendingLiveFocus = '';

  function kobeVideoTitle(bv) {
    var list = KOBE_CLASSICS;
    for (var i = 0; i < list.length; i++) {
      for (var j = 0; j < list[i].items.length; j++) {
        if (list[i].items[j].id === bv) return list[i].items[j].title;
      }
    }
    return '科比经典视频';
  }

  function route() {
    var hash = location.hash || '';
    // 离开科比视频页就把内嵌播放器摘掉，别在后台继续出声
    if (!/^#\/play\//.test(hash)) clearKobeEmbed();
    var m = hash.match(/^#\/replay\/(.+)$/);
    if (m) {
      showReplay(decodeURIComponent(m[1]));
      return;
    }

    // 分享链接：#/play/BVxxxx 直接打开某个经典视频
    var pv = hash.match(/^#\/play\/(BV[0-9A-Za-z]{10})$/);
    if (pv) {
      openKobeVideo(pv[1], kobeVideoTitle(pv[1]));
      return;
    }

    // 直播播放中：刷新 / 前进回到这个地址时，能重开刚才那场
    if (hash === '#/live/playing') {
      if (state.screen === 'replay' && state.isLive) return;
      if (state.liveSource) {
        openLive(state.liveSource, state.liveTitle);
      } else {
        showScreen('live');
        loadLives();
      }
      return;
    }

    if (hash === '#/live') {
      showScreen('live');
      loadLives();
      return;
    }

    if (hash === '#/rank') {
      // 排名已经并到赛程页，老链接也落到「排名」选项卡
      state.schTab = 'rank';
      showScreen('schedule');
      loadRank();
      return;
    }

    if (hash === '#/schedule') {
      // 从菜单进赛程页，默认回到 NBA 赛程
      state.schTab = 'schedule';
      showScreen('schedule');
      if (!state.schLoaded) loadSchedule(state.date);
      return;
    }

    if (hash === '#/kobe') {
      showScreen('kobe');
      loadKobe();
      if (state.kobeY != null) {
        var ky = state.kobeY;
        state.kobeY = null;
        setTimeout(function () { try { window.scrollTo(0, ky); } catch (err) { /* 忽略 */ } }, 0);
      }
      return;
    }

    showScreen('list');
    // 进入 App 默认焦点停在「录像」菜单上，按下键再进内容
    var listTab = el.nav.querySelector('.tab.is-active');
    if (listTab) setFocus(listTab, true);
    if (!state.page) loadNext();
    if (state.listY != null) {
      var ly = state.listY;
      state.listY = null;
      setTimeout(function () { try { window.scrollTo(0, ly); } catch (err) { /* 忽略 */ } }, 0);
    }
  }

  // ---------------- 原生壳判断 ----------------

  /** App 内（WebView 原生壳）会注入 NativeApp；浏览器里没有 */
  function inNativeShell() {
    try {
      if (window.NativeApp || window.WuxieApp) return true;
    } catch (err) {
      /* 忽略 */
    }
    return /wuxieapp|wuxie-app/i.test(navigator.userAgent || '');
  }

  /** 网页里显示「下载安装包」，App 内隐藏 */
  function initDownloadEntry() {
    var native = inNativeShell();
    if (document.body) document.body.classList.toggle('is-app', native);
    if (el.dlEntry) el.dlEntry.hidden = native;
  }

  // ---------------- 网页端（浏览器）专属交互 ----------------
  // APK（电视 / 手机壳）里一律不启用，遥控器逻辑完全不动

  var wrapClickTimer = null;
  var wrapClickCount = 0;

  /** 按比例跳到指定位置，像其他播放器一样点哪播哪 */
  function seekToRatio(ratio) {
    var dur = el.video.duration || 0;
    if (!dur || !isFinite(dur)) return;
    var to = Math.max(0, Math.min(dur - 0.3, dur * ratio));
    try {
      el.video.currentTime = to;
    } catch (err) {
      return;
    }
    syncProgress();
    if (el.video.paused) el.video.play().catch(function () {});
    showBar(2200);
  }

  function ratioOfEvent(e) {
    var rect = el.pbTrack.getBoundingClientRect();
    var x = (e.clientX || 0) - rect.left;
    if (!rect.width) return 0;
    return Math.min(1, Math.max(0, x / rect.width));
  }

  function initWebPlayer() {
    if (inNativeShell()) return; // APK 内不折腾
    document.body.classList.add('is-web');

    if (el.pbFull) el.pbFull.hidden = false;

    // 点 / 拖进度条 → 就地跳转播放（直播页是 iframe，跳过）
    if (el.pbTrack) {
      var dragging = false;

      el.pbTrack.addEventListener('pointerdown', function (e) {
        if (state.screen !== 'replay' || state.isLive) return;
        dragging = true;
        e.preventDefault();
        e.stopPropagation();
        seekToRatio(ratioOfEvent(e));
      });

      el.pbTrack.addEventListener('pointermove', function (e) {
        if (!dragging || state.screen !== 'replay' || state.isLive) return;
        e.stopPropagation();
        seekToRatio(ratioOfEvent(e));
      });

      ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (name) {
        el.pbTrack.addEventListener(name, function () {
          dragging = false;
        });
      });

      // 进度条区域的点击不要穿透成「放大 / 暂停」
      el.pbTrack.addEventListener('click', function (e) {
        e.stopPropagation();
      });

      var pbWrap = el.pbTrack.parentNode;
      if (pbWrap) {
        pbWrap.addEventListener('click', function (e) {
          if (el.pbTrack.contains(e.target) || e.target === el.pbFull) e.stopPropagation();
        });
      }
    }

    // 右下角全屏按钮
    if (el.pbFull) {
      el.pbFull.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        if (state.screen !== 'replay') return;
        if (state.playerFull) exitPlayerFull();
        else enterPlayerFull();
      });
    }
  }

  // ---------------- 作者微信弹框 ----------------

  function openAuthor() {
    if (!el.authorModal) return;
    state.modalOpen = true;
    state.modalKind = 'author';
    el.authorModal.hidden = false;
    setFocus(el.authorClose || el.authorModal);
  }

  function closeAuthor() {
    if (!state.modalOpen) return;
    state.modalOpen = false;
    state.modalKind = '';
    el.authorModal.hidden = true;
    setFocus(el.authorBtn, true);
  }

  // ---------------- 下载安装包弹框 ----------------

  function openDownload() {
    if (!el.dlModal || inNativeShell()) return; // App 里不弹
    state.modalOpen = true;
    state.modalKind = 'download';
    el.dlModal.hidden = false;
    setFocus(el.dlModal.querySelector('.dl-item') || el.dlModal);
  }

  function closeDownload() {
    if (!state.modalOpen) return;
    state.modalOpen = false;
    state.modalKind = '';
    el.dlModal.hidden = true;
    if (el.dlEntry) setFocus(el.dlEntry, true);
  }

  /** 无论当前开的是哪个弹框，统一关掉 */
  function closeModal() {
    if (state.modalKind === 'download') closeDownload();
    else closeAuthor();
  }

  // ---------------- 事件 ----------------

  document.addEventListener('click', function (e) {
    var target = e.target;
    if (!target || !target.closest) return;

    // 科比经典视频卡片：直接在本页播放
    var vcard = target.closest('[data-bv]');
    if (vcard) {
      setFocus(vcard);
      openKobeVideo(vcard.dataset.bv, vcard.dataset.title || '科比经典视频');
      return;
    }

    var navBtn = target.closest('[data-nav]');
    if (navBtn) {
      go(navBtn.dataset.nav);
      return;
    }

    if (target.closest('#refresh')) {
      setFocus(el.refresh);
      refreshCurrent();
      return;
    }

    if (target.closest('#more-btn')) {
      setFocus(el.moreBtn);
      toggleMorePanel();
      return;
    }

    var teamBtn = target.closest('.chip-btn[data-team]');
    if (teamBtn) {
      setFocus(teamBtn);
      setTeamFilter(teamBtn.dataset.team);
      return;
    }

    var liveBtn = target.closest('.chip-btn[data-live]');
    if (liveBtn) {
      setFocus(liveBtn);
      state.live.filter = liveBtn.dataset.live || '';
      var chips = el.liveFilter.querySelectorAll('.chip-btn');
      for (var c = 0; c < chips.length; c++) {
        chips[c].classList.toggle('is-active', (chips[c].dataset.live || '') === state.live.filter);
      }
      syncLiveTitle();
      renderLives();
      return;
    }

    var liveRow = target.closest('.live-row');
    if (liveRow) {
      setFocus(liveRow, true);
      openLive(liveRow.dataset.url, liveRow.dataset.title);
      return;
    }

    var liveLine = target.closest('.line-btn[data-live-line]');
    if (liveLine) {
      setFocus(liveLine);
      playLiveLine(Number(liveLine.dataset.liveLine));
      return;
    }

    var schTabBtn = target.closest('.seg-btn[data-sch]');
    if (schTabBtn) {
      setFocus(schTabBtn);
      var tab = schTabBtn.dataset.sch === 'rank' ? 'rank' : 'schedule';
      applySchTab(tab);
      if (tab === 'rank') loadRank();
      else if (!state.schLoaded) loadSchedule(state.date);
      window.scrollTo(0, 0);
      return;
    }

    var kindBtn = target.closest('.seg-btn[data-kind]');
    if (kindBtn) {
      setFocus(kindBtn);
      switchRankKind(kindBtn.dataset.kind);
      return;
    }

    var groupBtn = target.closest('.chip-btn[data-group]');
    if (groupBtn) {
      var groupIndex = Number(groupBtn.dataset.group);
      state.rankGroup = groupIndex;
      renderRank();
      // 分组按钮会整排重绘，按原索引把焦点找回来
      var againGroup = el.rankGroupBox.querySelector('.chip-btn[data-group="' + groupIndex + '"]');
      if (againGroup) setFocus(againGroup, true);
      return;
    }

    var bgmBtn = target.closest('.bgm-btn[data-bgm]');
    if (bgmBtn) {
      setFocus(bgmBtn);
      playBgm(Number(bgmBtn.dataset.bgm));
      return;
    }

    if (target.closest('#load-more-btn')) {
      loadNext(true);
      return;
    }

    var card = target.closest('.card');
    if (card) {
      location.hash = '#/replay/' + encodeURIComponent(card.dataset.id);
      return;
    }

    var lineBtn = target.closest('.line-btn');
    if (lineBtn && lineBtn.dataset.line != null) {
      setFocus(lineBtn);
      playLine(Number(lineBtn.dataset.line));
      return;
    }

    if (target.closest('#sch-prev')) {
      loadSchedule(shiftDate(state.date, -1));
      return;
    }

    if (target.closest('#sch-next')) {
      loadSchedule(shiftDate(state.date, 1));
      return;
    }

    if (target.closest('#sch-today')) {
      loadSchedule(todayStr());
      return;
    }

    var action = target.closest('[data-action]');
    if (action) {
      var name = action.dataset.action;
      if (name === 'retry') loadNext(true);
      else if (name === 'retry-rank') loadRank();
      else if (name === 'retry-sch') loadSchedule(state.date);
      else if (name === 'retry-kobe') loadKobe(true);
      else if (name === 'retry-live') loadLives(true);
      else if (name === 'retry-liveplay') openLive(state.liveSource, state.liveTitle);
      else if (name === 'retry-replay') showReplay(state.detailId);
      else if (name === 'author') openAuthor();
      else if (name === 'close-author') closeAuthor();
      else if (name === 'download') openDownload();
      else if (name === 'close-download') closeDownload();
      return;
    }

    var focused = target.closest('.focusable');
    if (focused) setFocus(focused);
  });

  el.schDate.addEventListener('change', function () {
    if (el.schDate.value) loadSchedule(el.schDate.value);
  });

  var DIR_KEYS = {
    ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down',
    37: 'left', 39: 'right', 38: 'up', 40: 'down'
  };

  // 电视遥控器的 OK 键在不同盒子上可能是 Enter / 小键盘 Enter / DPAD_CENTER(23)
  function isEnterKey(e) {
    return e.key === 'Enter' || e.key === 'OK' || e.keyCode === 13 || e.keyCode === 23;
  }

  /** 方向键（repeat 为遥控器 / 键盘的重复事件） */
  function handleDir(dir, repeat) {
    // 作者弹框打开时，方向键不再穿透到列表
    if (state.modalOpen) return;
    if (state.playerFull) {
      // 直播是网页播放器，没有我们自己的快进逻辑
      if (state.isLive) return;
      if (dir === 'left' || dir === 'right') {
        if (repeat) seekAlive();
        seekStart(dir);
      }
      return;
    }
    move(dir);
  }

  function handleEnter() {
    // 弹框里 OK 只作用于「关闭」按钮
    if (state.modalOpen) {
      activate();
      return;
    }
    if (state.playerFull) {
      // 全屏时快速连按两次 OK → 退出全屏
      var now = Date.now();
      if (now - fullOkAt < 450) {
        fullOkAt = 0;
        exitPlayerFull();
        return;
      }
      fullOkAt = now;
      if (!state.isLive) togglePlay();
      return;
    }
    var cur = currentFocus();
    // 日期框：OK 键打开系统日期选择器，方向键仍可正常移走
    if (cur === el.schDate) {
      openDatePicker();
      return;
    }
    // 回放页：只要焦点不在按钮上（视频、空白），OK 就全屏播放
    if (state.screen === 'replay') {
      var onAction = cur && (cur.tagName === 'BUTTON' || cur.classList.contains('tab') ||
        cur.classList.contains('line-btn'));
      if (!onAction) {
        enterPlayerFull();
        return;
      }
    }
    if (cur && cur.tagName === 'VIDEO') return;
    activate();
  }

  function openDatePicker() {
    try {
      if (typeof el.schDate.showPicker === 'function') {
        el.schDate.showPicker();
        return;
      }
    } catch (err) {
      /* 部分电视 WebView 不支持，退回到 click */
    }
    try { el.schDate.click(); } catch (err2) { /* 忽略 */ }
  }

  /** 返回：视频全屏时先缩小，回放页回列表，其余回上一页 */
  function handleBackKey() {
    if (state.modalOpen) {
      closeModal();
      return;
    }
    if (state.playerFull) {
      exitPlayerFull();
      return;
    }
    // 刚退出全屏时忽略连发的返回键，避免一下子退出页面
    if (Date.now() - lastExitFullAt < 450) return;
    // 电视习惯：内容区按返回先把焦点收回当前菜单，再按一下才退出页面
    if (state.screen !== 'replay') {
      var cur = currentFocus();
      if (cur && !isTopbarNode(cur)) {
        var activeTab = el.nav.querySelector('.tab.is-active') || el.nav.querySelector('.tab');
        if (activeTab) {
          setFocus(activeTab, true);
          return;
        }
      }
    }
    if (state.screen === 'replay') {
      var back = state.backHash || '#/';
      // 直播播放页没有改 hash，直接重路由回直播列表
      if (location.hash === back) route();
      else location.hash = back;
      return;
    }
    if (history.length > 1) history.back();
  }

  /** 遥控器上的播放/暂停、快进、快退实体键 */
  function handleMediaKey(code) {
    if (state.modalOpen) return;
    if (state.screen !== 'replay' || state.isLive) return;
    if (code === 90 || code === 88) {
      seekBy(15);
      return;
    }
    if (code === 89 || code === 87) {
      seekBy(-15);
      return;
    }
    if (code === 85) {
      togglePlay();
      return;
    }
    if (code === 126) {
      el.video.play().catch(function () {});
      return;
    }
    if (code === 127) {
      el.video.pause();
    }
  }

  document.addEventListener('keydown', function (e) {
    var dir = DIR_KEYS[e.key] || DIR_KEYS[e.keyCode];

    if (dir) {
      e.preventDefault();
      // 长按连发时限速，避免一次积压太多移动
      if (e.repeat && !state.playerFull) {
        var t = Date.now();
        if (t - lastKeyMoveAt < 80) return;
        lastKeyMoveAt = t;
      }
      handleDir(dir, e.repeat);
      return;
    }

    if (isEnterKey(e)) {
      e.preventDefault();
      if (!e.repeat) handleEnter();
      return;
    }

    if (e.key === 'Escape' || e.key === 'Backspace' || e.keyCode === 27 || e.keyCode === 8) {
      if (state.modalOpen || state.screen === 'replay' || state.playerFull) {
        e.preventDefault();
        handleBackKey();
      }
    }
  });

  document.addEventListener('keyup', function (e) {
    if (DIR_KEYS[e.key] || DIR_KEYS[e.keyCode]) seekStop();
  });

  window.addEventListener('blur', function () {
    seekStop();
  });

  // 用户用系统方式退出全屏时，同步回小窗状态
  ['fullscreenchange', 'webkitfullscreenchange'].forEach(function (name) {
    document.addEventListener(name, function () {
      if (!(document.fullscreenElement || document.webkitFullscreenElement) && state.playerFull) {
        setPlayerFull(false);
      }
    });
  });

  // 鼠标点视频也能全屏 / 暂停
  el.playerWrap.addEventListener('click', function () {
    if (state.screen !== 'replay') return;

    // 网页端全屏状态：单击暂停/播放，快速双击直接退出全屏
    if (state.playerFull && document.body.classList.contains('is-web')) {
      wrapClickCount += 1;
      if (wrapClickCount === 1) {
        clearTimeout(wrapClickTimer);
        wrapClickTimer = setTimeout(function () {
          wrapClickCount = 0;
          if (state.playerFull) togglePlay();
        }, 260);
      } else {
        clearTimeout(wrapClickTimer);
        wrapClickTimer = null;
        wrapClickCount = 0;
        exitPlayerFull();
      }
      return;
    }

    if (state.playerFull) togglePlay();
    else enterPlayerFull();
  });

  // 线路左侧的全屏按钮
  el.fullBtn.addEventListener('click', function () {
    if (state.screen !== 'replay') return;
    if (state.playerFull) exitPlayerFull();
    else enterPlayerFull();
  });

  window.addEventListener('hashchange', function () {
    // go() / 切播放页地址时已经同步处理过，这里跳过重复渲染
    if (skipNextHashRoute) {
      skipNextHashRoute = false;
      return;
    }
    route();
  });

  el.video.addEventListener('playing', function () {
    el.playerState.hidden = true;
  });

  ['play', 'pause', 'ended'].forEach(function (name) {
    el.bgmAudio.addEventListener(name, syncBgmUI);
  });

  // 正常播放时进度条露一下就自动收起；暂停时一直显示
  el.video.addEventListener('play', function () {
    showBar(2600);
  });

  el.video.addEventListener('pause', function () {
    saveResume();
    showBar(0);
  });

  el.video.addEventListener('seeking', function () {
    showBar(4000);
  });

  el.video.addEventListener('seeked', function () {
    if (!el.video.paused) showBar(1800);
  });

  el.video.addEventListener('loadedmetadata', applyResume);

  el.video.addEventListener('ended', clearResume);

  el.video.addEventListener('timeupdate', function () {
    syncProgress();
    var now = Date.now();
    // 播放中每 4 秒记一次断点，异常退出也不至于丢太多进度
    if (now - lastResumeSave > 4000) {
      lastResumeSave = now;
      saveResume();
    }
  });

  ['durationchange', 'emptied', 'seeked'].forEach(function (name) {
    el.video.addEventListener(name, syncProgress);
  });

  // 滚动到底自动加载下一页
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(
      function (entries) {
        if (entries[0].isIntersecting && state.screen === 'list' && hasMore() && !state.loading) {
          loadNext();
        }
      },
      { rootMargin: '320px 0px' }
    );
    io.observe(el.sentinel);
  }

  // 提供给原生壳（TV 遥控器）调用的接口
  var lastKeyMoveAt = 0;

  window.TV = {
    move: move,
    activate: activate,
    focusFirst: function () {
      var nodes = focusables();
      if (nodes.length) setFocus(nodes[0]);
    },

    /**
     * 原生层把遥控器按键原样转发过来（不依赖 WebView 的键值映射）：
     * 19/20/21/22 方向，23/66/160/96 确定，4 返回，85 播放暂停，89/90 快退快进
     */
    onKey: function (code, repeat) {
      var held = repeat > 0;
      var dirCode = code === 19 || code === 20 || code === 21 || code === 22;
      // 确定 / 返回 / 媒体键长按不重复触发，避免连续翻页或反复暂停
      if (!dirCode && held) return;
      // 菜单移动时限速，遥控器连发太快时不会堆积导致卡顿
      if (dirCode && held && !state.playerFull) {
        var now = Date.now();
        if (now - lastKeyMoveAt < 80) return;
        lastKeyMoveAt = now;
      }
      if (code === 19) { handleDir('up', held); return; }
      if (code === 20) { handleDir('down', held); return; }
      if (code === 21) { handleDir('left', held); return; }
      if (code === 22) { handleDir('right', held); return; }
      if (code === 23 || code === 66 || code === 160 || code === 96 || code === 13) {
        handleEnter();
        return;
      }
      if (code === 4) {
        handleBackKey();
        return;
      }
      handleMediaKey(code);
    },

    onKeyUp: function (code) {
      if (code === 21 || code === 22 || code === 37 || code === 39) seekStop();
    },

    /** 遥控器返回键：视频全屏时先缩小，否则回上一页 */
    onBack: handleBackKey
  };

  // ?keys=1 时在角落显示遥控器实际按键码，方便适配不同盒子
  if (/[?&]keys=1/.test(location.search)) {
    var hud = document.createElement('div');
    hud.style.cssText =
      'position:fixed;left:16px;bottom:16px;z-index:99;background:rgba(0,0,0,.75);color:#ffd166;' +
      'padding:8px 14px;border-radius:10px;font-size:16px;font-family:monospace;pointer-events:none';
    hud.textContent = '按键码：-';
    document.body.appendChild(hud);
    var rawOnKey = window.TV.onKey;
    window.TV.onKey = function (code) {
      hud.textContent = '按键码：' + code;
      return rawOnKey.apply(window.TV, arguments);
    };
    document.addEventListener('keydown', function (e) {
      hud.textContent = '按键码：' + e.keyCode + ' (' + e.key + ')';
    }, true);
  }

  window.SOTV_RESUME = function () {
    if (state.screen === 'list' && !state.page) loadNext();
  };

  // 百度统计：单页应用里 hash 变化也记一次 PV，后台才能看到各页面访问量
  function trackPageview() {
    try {
      if (window._hmt) {
        var path = (location.hash || '').replace(/^#/, '');
        _hmt.push(['_trackPageview', path || '/']);
      }
    } catch (err) {
      /* 统计脚本没加载到就算了 */
    }
  }
  window.addEventListener('hashchange', trackPageview);
  trackPageview();

  el.schDate.value = state.date;
  initDownloadEntry();
  initWebPlayer();
  renderKobeClassics();
  renderMorePanel();
  renderBgm();
  route();
})();

