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
    // 赛程
    date: todayStr(),
    schLoading: false,
    schLoaded: false,
    // 播放页
    detail: null,
    detailId: '',
    backHash: '#/',
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
    modalOpen: false
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
    video: document.getElementById('player'),
    playerState: document.getElementById('player-state'),

    authorBtn: document.querySelector('.author'),
    authorModal: document.getElementById('author-modal'),
    authorClose: document.getElementById('author-close')
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
    rank: function () { return el.rankScreen; },
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
    var top = topbarBottom() + 12;
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

  function scrollStep(dir) {
    var view = Math.max(window.innerHeight - topbarBottom(), 240);
    // 排名 / 科比是长列表，滚动步长再小一点，方便一行行慢慢看
    var ratio = state.screen === 'rank' || state.screen === 'kobe'
      ? 0.28
      : state.screen === 'schedule' ? 0.42 : 0.82;
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

    // 排名页：从「球队数据 / 球员数据」按下键，落到分组栏的第一个选项
    if (dir === 'down' && cur.classList.contains('seg-btn')) {
      var firstChip = el.rankGroupBox.querySelector('.chip-btn');
      if (firstChip) {
        setFocus(firstChip);
        return;
      }
    }

    var best = pickInDirection(contentFocusables(), cur, dir);

    // 科比页文字很长：往下按时目标还在屏幕外就先滚屏，不要直接跳到最下面的视频
    if (best && dir === 'down' && state.screen === 'kobe') {
      if (best.getBoundingClientRect().top > window.innerHeight - 60 && canScroll('down')) {
        scrollStep('down');
        return;
      }
    }

    if (best) {
      // 直接聚焦目标（ensureVisible 会滚动到视野内），上下左右都能即时响应
      setFocus(best);
      followFocus(best);
      return;
    }

    if (dir === 'down' || dir === 'up') {
      if (canScroll(dir)) {
        scrollStep(dir);
        return;
      }
      // 向上到头回到菜单；向下到底就停住，不再乱跳
      if (dir === 'up') {
        var active = el.nav.querySelector('.tab.is-active') || el.nav.querySelector('.tab');
        if (active) setFocus(active);
      }
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

  function visibleLives() {
    var filter = state.live.filter;
    return state.live.items.filter(function (it) {
      return !filter || (it.league || '').indexOf(filter) >= 0;
    });
  }

  function renderLives() {
    var items = visibleLives();
    el.liveCount.textContent = items.length ? '共 ' + items.length + ' 场' : '';

    if (!items.length) {
      el.liveList.innerHTML =
        '<div class="notice"><strong>暂无' + esc(state.live.filter || '篮球') + '直播</strong>' +
        '<span>可以切到「全部」看看其他篮球赛事</span></div>';
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
      '<div class="notice"><strong>直播加载中…</strong><span>正在拉取最新篮球赛程</span></div>';

    fetch(api('/api/lives' + (force ? '?refresh=1' : '')))
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

  // ---------------- 科比专属 BGM ----------------

  var KOBE_BGM = [
    { name: 'Because of You', file: 'assets/kobe/Because of You.mp3' },
    { name: 'Dancing With Your Ghost', file: 'assets/kobe/Dancing With Your Ghost.mp3' },
    { name: 'See You Again', file: 'assets/kobe/See You Again.mp3' }
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
      showPlayerTip(
        state.isLive ? '返回键退出全屏' : 'OK 暂停/播放 · 长按 ← → 快退/快进 · 返回键缩小',
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

  function showReplay(id) {
    state.backHash = state.screen === 'kobe'
      ? '#/kobe'
      : state.screen === 'replay' ? state.backHash : '#/';
    state.screen = 'replay';
    state.detailId = id;
    stopLive();
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
    el.rankScreen.hidden = name !== 'rank';
    el.schScreen.hidden = name !== 'schedule';
    el.kobeScreen.hidden = name !== 'kobe';
    el.replayScreen.hidden = true;
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
    } else if (state.screen === 'rank') {
      state.rank[state.rankKind] = null;
      loadRank(true);
    } else if (state.screen === 'live') {
      loadLives(true);
    } else if (state.screen === 'schedule') {
      loadSchedule(state.date, true);
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

  function route() {
    var hash = location.hash || '';
    var m = hash.match(/^#\/replay\/(.+)$/);
    if (m) {
      showReplay(decodeURIComponent(m[1]));
      return;
    }

    if (hash === '#/live') {
      showScreen('live');
      loadLives();
      return;
    }

    if (hash === '#/rank') {
      showScreen('rank');
      loadRank();
      return;
    }

    if (hash === '#/schedule') {
      showScreen('schedule');
      if (!state.schLoaded) loadSchedule(state.date);
      return;
    }

    if (hash === '#/kobe') {
      showScreen('kobe');
      loadKobe();
      return;
    }

    showScreen('list');
    // 进入 App 默认焦点停在「录像」菜单上，按下键再进内容
    var listTab = el.nav.querySelector('.tab.is-active');
    if (listTab) setFocus(listTab, true);
    if (!state.page) loadNext();
  }

  // ---------------- 作者微信弹框 ----------------

  function openAuthor() {
    if (!el.authorModal) return;
    state.modalOpen = true;
    el.authorModal.hidden = false;
    setFocus(el.authorClose || el.authorModal);
  }

  function closeAuthor() {
    if (!state.modalOpen) return;
    state.modalOpen = false;
    el.authorModal.hidden = true;
    setFocus(el.authorBtn, true);
  }

  // ---------------- 事件 ----------------

  document.addEventListener('click', function (e) {
    var target = e.target;
    if (!target || !target.closest) return;

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

    var kindBtn = target.closest('.seg-btn');
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
      closeAuthor();
      return;
    }
    if (state.playerFull) {
      exitPlayerFull();
      return;
    }
    // 刚退出全屏时忽略连发的返回键，避免一下子退出页面
    if (Date.now() - lastExitFullAt < 450) return;
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
    // go() 里已经同步切过页，这里跳过重复渲染
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

  el.schDate.value = state.date;
  renderMorePanel();
  renderBgm();
  route();
})();
