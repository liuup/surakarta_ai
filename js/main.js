/*!
 * 网页界面：只负责画棋盘与处理鼠标，对局状态一律来自「驱动」
 *
 * 驱动有两种，界面代码完全一样：
 *   - 在线：后端服务（server.js）的 /api/… 接口。此时网页与终端 TUI 共用同一局棋。
 *   - 离线：直接在本页跑 js/session.js。双击 index.html 打开时自动走这条路。
 */
(function () {
  'use strict';

  var R = window.SurakartaRules;
  var Session = window.SurakartaSession;
  var I18N = window.SurakartaI18n;

  // ---------------------------------------------------------------- 语言
  /*
   * 默认英文（I18N.DEFAULT_LOCALE），不跟随系统语言；使用者在标题栏右侧切换，
   * 选择记在 localStorage 里。界面上的文字一律经 t() 取出。
   */
  var LOCALE_KEY = 'surakarta.locale';

  function loadLocale() {
    try { return I18N.normalize(localStorage.getItem(LOCALE_KEY)); }
    catch (e) { return I18N.DEFAULT_LOCALE; }        // 隐私模式下 localStorage 会抛错
  }
  function saveLocale(code) {
    try { localStorage.setItem(LOCALE_KEY, code); } catch (e) { /* 存不了就算了 */ }
  }

  var locale = loadLocale();
  function t(key, params) { return I18N.t(locale, key, params); }

  var MARGIN = 2.35;                          // 棋盘四周为角环预留的宽度（单位：格）
  var WORLD = (R.SIZE - 1) + MARGIN * 2;      // 画布覆盖的格数

  var canvas = document.getElementById('board');
  var g = canvas.getContext('2d');
  var wrap = document.getElementById('canvas-wrap');

  var els = {
    turn: document.getElementById('turn-indicator'),
    thinking: document.getElementById('thinking'),
    thinkingText: document.getElementById('thinking-text'),
    message: document.getElementById('message'),
    countBlack: document.getElementById('count-black'),
    countRed: document.getElementById('count-red'),
    cardBlack: document.getElementById('card-black'),
    cardRed: document.getElementById('card-red'),
    levelGrid: document.getElementById('level-grid'),
    levelHint: document.getElementById('level-hint'),
    statDepth: document.getElementById('stat-depth'),
    statScore: document.getElementById('stat-score'),
    statNodes: document.getElementById('stat-nodes'),
    statTime: document.getElementById('stat-time'),
    moveList: document.getElementById('move-list'),
    btnNew: document.getElementById('btn-new'),
    btnUndo: document.getElementById('btn-undo'),
    btnAgree: document.getElementById('btn-agree'),
    link: document.getElementById('link-status'),
    langSwitch: document.getElementById('lang-switch')
  };

  // 界面自身的状态（与对局无关的部分）
  var ui = {
    state: null,
    locale: locale,
    selected: -1,
    hints: [],
    hoverPath: null,
    hoverKey: '',
    banner: '',
    lastScore: null
  };

  var view = { scale: 1, dpr: 1 };

  // ---------------------------------------------------------------- 驱动

  function localDriver(session) {
    var running = false;
    return {
      nameKey: 'conn.offline',
      getState: function () { return Promise.resolve(session.state()); },
      hints: function (cell) { return Promise.resolve(session.movesFrom(cell)); },
      newGame: function (o) { session.newGame(o); return driveLocal(); },
      move: function (m) { return settle(session.playMove(m), driveLocal); },
      undo: function () { return settle(session.undo(), driveLocal); },
      agree: function () { return settle(session.agreeEnd()); },
      setLevel: function (i) { return settle(session.setLevel(i)); },
      setHumanSide: function (s) { return settle(session.setHumanSide(s), driveLocal); },
      loadPosition: function (board, side) {
        return settle(session.loadPosition(board, side), driveLocal);
      }
    };

    /* 会话返回 { ok, error:{code,params} }：失败时带着这个载荷 reject，
     * 与后端接口的失败形式保持一致，run() 里就能用同一套话术显示。 */
    function settle(result, then) {
      if (result && result.ok === false) {
        var err = new Error();
        err.payload = result;
        return Promise.reject(err);
      }
      return then ? then() : Promise.resolve(result);
    }

    // 本地模式下由页面自己推进 AI 搜索：每次约 16 毫秒，然后让出主线程
    function driveLocal() {
      if (running || !session.needsAI()) return Promise.resolve();
      running = true;
      session.startAI({ chunkMs: 16 });
      return new Promise(function (resolve) {
        function step() {
          var result = session.stepAI();
          applyState(session.state());   // 只有局面真的变了才重画棋盘
          updatePanel();                 // 文字面板每段都刷新，思考进度才动得起来
          if (result.done) { running = false; resolve(); return; }
          setTimeout(step, 0);
        }
        setTimeout(step, 60);          // 先让界面把「思考中」画出来
      });
    }
  }

  function httpDriver(base) {
    function call(route, body) {
      return fetch(base + route, {
        method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body)
      }).then(function (res) {
        return res.json().catch(function () {
          return { ok: false, error: { code: 'conn.badResponse', params: {} } };
        });
      }).then(function (data) {
        if (data.state) applyState(data.state);
        if (data.ok === false) throw new Error(explainError(data));
        return data;
      });
    }
    return {
      nameKey: 'conn.online',
      getState: function () { return call('/api/state').then(function (d) { return d.state; }); },
      hints: function (cell) { return call('/api/hints?cell=' + cell).then(function (d) { return d.hints; }); },
      newGame: function (o) { return call('/api/new', o || {}); },
      move: function (m) { return call('/api/move', { move: m }); },
      undo: function () { return call('/api/undo', {}); },
      agree: function () { return call('/api/agree', {}); },
      setLevel: function (i) { return call('/api/level', { level: i }); },
      setHumanSide: function (s) { return call('/api/side', { side: s }); }
    };
  }

  var driver = null;

  /*
   * 后端返回的错误是 { code, params }，由这里按当前语言翻译。
   * 服务端另外附了一条它自己语言的可读文本，只在没有错误码时兜底。
   */
  function explainError(payload) {
    var err = payload && payload.error;
    if (err && typeof err === 'object' && err.code) {
      var text = I18N.t(locale, err.code, err.params);
      if (text !== err.code) return text;
    }
    if (payload && typeof payload.message === 'string' && payload.message) return payload.message;
    return t('err.actionFailed');
  }

  /** 把驱动抛出的东西统一变成一句能显示的话 */
  function messageOf(err) {
    if (!err) return t('err.actionFailed');
    if (err.payload) return explainError(err.payload);
    if (err.error && typeof err.error === 'object') return explainError(err);
    return err.message || String(err);
  }

  // ---------------------------------------------------------------- 绘制

  function lineColor(index) {
    if (R.INNER_LINES.indexOf(index) >= 0) return getVar('--inner-line', '#1c9bc4');
    if (R.OUTER_LINES.indexOf(index) >= 0) return getVar('--outer-line', '#2e9e46');
    return getVar('--edge-line', '#6b5136');
  }

  var cssCache = {};
  function getVar(name, fallback) {
    if (!cssCache[name]) {
      var value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      cssCache[name] = value || fallback;
    }
    return cssCache[name];
  }

  function strokePolyline(poly, color, width) {
    if (!poly || poly.length < 2) return;
    g.beginPath();
    g.moveTo(poly[0].x, poly[0].y);
    for (var i = 1; i < poly.length; i++) g.lineTo(poly[i].x, poly[i].y);
    g.strokeStyle = color;
    g.lineWidth = width;
    g.lineJoin = 'round';
    g.lineCap = 'round';
    g.stroke();
  }

  function drawBoardSurface() {
    var grad = g.createLinearGradient(-MARGIN, -MARGIN, MARGIN + 5, MARGIN + 5);
    grad.addColorStop(0, '#f6e7cb');
    grad.addColorStop(0.55, '#eeddba');
    grad.addColorStop(1, '#e0cba3');
    g.fillStyle = grad;
    g.fillRect(-MARGIN, -MARGIN, WORLD, WORLD);

    g.strokeStyle = 'rgba(107, 81, 54, 0.55)';
    g.lineWidth = 0.05;
    roundRect(-0.62, -0.62, R.SIZE - 1 + 1.24, R.SIZE - 1 + 1.24, 0.18);
    g.stroke();
  }

  function roundRect(x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  function drawLoops() {
    for (var i = 0; i < R.CIRCLES.length; i++) {
      var circle = R.CIRCLES[i];
      strokePolyline(R.loopArcPoints(circle, 60), circle.inner ? lineColor(1) : lineColor(2), 0.058);
    }
  }

  function drawGridLines() {
    var order = [0, 5].concat(R.INNER_LINES, R.OUTER_LINES);   // 先画最外侧的线，再画回路
    var last = R.SIZE - 1;
    for (var i = 0; i < order.length; i++) {
      var index = order[i];
      g.strokeStyle = lineColor(index);
      g.lineWidth = 0.055;
      g.beginPath();
      g.moveTo(0, index); g.lineTo(last, index);
      g.moveTo(index, 0); g.lineTo(index, last);
      g.stroke();
    }
  }

  function drawJunctions() {
    g.fillStyle = 'rgba(88, 66, 42, 0.45)';
    for (var cell = 0; cell < R.CELLS; cell++) {
      g.beginPath();
      g.arc(R.colOf(cell), R.rowOf(cell), 0.045, 0, Math.PI * 2);
      g.fill();
    }
  }

  function drawPiece(cell, piece) {
    var x = R.colOf(cell), y = R.rowOf(cell);
    var grad = g.createRadialGradient(x - 0.12, y - 0.14, 0.05, x, y, 0.42);
    if (piece === R.BLACK) {
      grad.addColorStop(0, '#666e7d');
      grad.addColorStop(0.5, '#272b34');
      grad.addColorStop(1, '#0d0f13');
    } else {
      grad.addColorStop(0, '#f29a90');
      grad.addColorStop(0.5, '#c33328');
      grad.addColorStop(1, '#7a110d');
    }
    g.beginPath();
    g.arc(x + 0.03, y + 0.05, 0.365, 0, Math.PI * 2);
    g.fillStyle = 'rgba(60, 42, 24, 0.25)';
    g.fill();

    g.beginPath();
    g.arc(x, y, 0.365, 0, Math.PI * 2);
    g.fillStyle = grad;
    g.fill();
    g.lineWidth = 0.03;
    g.strokeStyle = piece === R.BLACK ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.34)';
    g.stroke();

    g.beginPath();
    g.arc(x - 0.11, y - 0.12, 0.075, 0, Math.PI * 2);
    g.fillStyle = 'rgba(255,255,255,0.22)';
    g.fill();
  }

  function drawPieces(board) {
    for (var cell = 0; cell < R.CELLS; cell++) {
      if (board[cell] !== R.EMPTY) drawPiece(cell, board[cell]);
    }
  }

  function drawHints() {
    for (var i = 0; i < ui.hints.length; i++) {
      var hint = ui.hints[i];
      var x = R.colOf(hint.to), y = R.rowOf(hint.to);
      if (hint.capture) {
        g.beginPath();
        g.arc(x, y, 0.40, 0, Math.PI * 2);
        g.fillStyle = 'rgba(198, 44, 36, 0.20)';
        g.fill();
        g.lineWidth = 0.065;
        g.strokeStyle = 'rgba(178, 34, 28, 0.95)';
        g.stroke();
      } else {
        g.beginPath();
        g.arc(x, y, 0.15, 0, Math.PI * 2);
        g.fillStyle = 'rgba(38, 62, 96, 0.34)';
        g.fill();
      }
    }
  }

  function drawSelection() {
    if (ui.selected < 0) return;
    g.beginPath();
    g.arc(R.colOf(ui.selected), R.rowOf(ui.selected), 0.45, 0, Math.PI * 2);
    g.lineWidth = 0.075;
    g.strokeStyle = 'rgba(38, 108, 214, 0.95)';
    g.stroke();
  }

  function drawLastMove(state) {
    if (state.lastMove === null || state.lastMove === undefined) return;
    var from = R.moveFrom(state.lastMove), to = R.moveTo(state.lastMove);
    g.beginPath();
    g.arc(R.colOf(from), R.rowOf(from), 0.42, 0, Math.PI * 2);
    g.lineWidth = 0.05;
    g.strokeStyle = 'rgba(70, 92, 128, 0.55)';
    g.stroke();
    g.beginPath();
    g.arc(R.colOf(to), R.rowOf(to), 0.45, 0, Math.PI * 2);
    g.lineWidth = 0.07;
    g.strokeStyle = 'rgba(46, 158, 70, 0.95)';
    g.stroke();
  }

  function draw() {
    var dpr = view.dpr, s = view.scale;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, canvas.width, canvas.height);
    g.setTransform(s * dpr, 0, 0, s * dpr, MARGIN * s * dpr, MARGIN * s * dpr);

    drawBoardSurface();
    drawLoops();
    drawGridLines();
    drawJunctions();
    if (ui.hoverPath) strokePolyline(ui.hoverPath, 'rgba(214, 86, 40, 0.45)', 0.075);
    if (ui.state && ui.state.lastPath) strokePolyline(ui.state.lastPath, 'rgba(214, 86, 40, 0.85)', 0.085);
    if (ui.state) {
      drawLastMove(ui.state);
      drawPieces(ui.state.board);
    }
    drawHints();
    drawSelection();
  }

  // ---------------------------------------------------------------- 交互

  function toCell(clientX, clientY) {
    var rect = canvas.getBoundingClientRect();
    var col = (clientX - rect.left) / rect.width * WORLD - MARGIN;
    var row = (clientY - rect.top) / rect.height * WORLD - MARGIN;
    var r = Math.round(row), c = Math.round(col);
    if (r < 0 || r >= R.SIZE || c < 0 || c >= R.SIZE) return -1;
    return r * R.SIZE + c;
  }

  /** 交叉点在页面上的像素坐标（供自动化测试使用） */
  function cellPoint(cell) {
    var rect = canvas.getBoundingClientRect();
    return {
      x: rect.left + (R.colOf(cell) + MARGIN) / WORLD * rect.width,
      y: rect.top + (R.rowOf(cell) + MARGIN) / WORLD * rect.height
    };
  }

  function state() { return ui.state || { board: new Array(R.CELLS).fill(0), side: R.BLACK, moves: [], counts: { black: 12, red: 12 } }; }

  function canHumanAct() {
    var s = ui.state;
    return !!s && s.status === 'playing' && !s.thinking && s.side === s.humanSide;
  }

  function clearSelection() {
    ui.selected = -1;
    ui.hints = [];
    ui.hoverPath = null;
    ui.hoverKey = '';
  }

  function run(promise) {
    return Promise.resolve(promise).then(function () {
      ui.banner = '';
      clearSelection();
      return refresh();
    }).catch(function (err) {
      ui.banner = messageOf(err);
      refresh().catch(function () {});
    });
  }

  function selectCell(cell) {
    ui.selected = cell;
    ui.hints = [];
    ui.hoverPath = null;
    ui.hoverKey = '';
    draw();
    Promise.resolve(driver.hints(cell)).then(function (hints) {
      if (ui.selected !== cell) return;          // 期间又点了别的地方
      ui.hints = hints || [];
      draw();
    }).catch(function () {});
  }

  canvas.addEventListener('click', function (event) {
    if (!canHumanAct()) return;
    var cell = toCell(event.clientX, event.clientY);
    if (cell < 0) return;
    for (var i = 0; i < ui.hints.length; i++) {
      if (ui.hints[i].to === cell) { run(driver.move(ui.hints[i].move)); return; }
    }
    if (state().board[cell] === state().humanSide) selectCell(cell);
    else { clearSelection(); draw(); }
  });

  canvas.addEventListener('mousemove', function (event) {
    if (!canHumanAct() || ui.selected < 0) return;
    var cell = toCell(event.clientX, event.clientY);
    var hint = null;
    for (var i = 0; i < ui.hints.length; i++) {
      if (ui.hints[i].to === cell) { hint = ui.hints[i]; break; }
    }
    var path = hint && hint.capture ? hint.path : null;
    // 以「起点 + 方向」为键判断悬停目标是否变化：在两个吃子目标之间移动时也要重绘，
    // 否则会一直停留在上一条绕行路线上。
    var key = hint ? ui.selected + ':' + hint.dir : '';
    if (key !== ui.hoverKey) {
      ui.hoverKey = key;
      ui.hoverPath = path;
      draw();
    } else {
      ui.hoverPath = path;
    }
  });

  canvas.addEventListener('mouseleave', function () {
    if (ui.hoverPath) { ui.hoverPath = null; ui.hoverKey = ''; draw(); }
  });

  // ---------------------------------------------------------------- 面板刷新

  var lastRenderedPosition = -1;

  function applyState(next) {
    ui.state = next;
    if (next.position !== lastRenderedPosition) {
      lastRenderedPosition = next.position;
      clearSelection();
      draw();
    }
  }

  function formatScore(score) {
    var WIN = window.SurakartaAI.WIN;
    if (score >= WIN - 1000) return t('stat.winning');
    if (score <= -(WIN - 1000)) return t('stat.losing');
    return (score >= 0 ? '+' : '') + (score / 100).toFixed(2);
  }

  function updatePanel() {
    var s = state();
    els.countBlack.textContent = String(s.counts.black);
    els.countRed.textContent = String(s.counts.red);
    els.cardBlack.classList.toggle('active', s.side === R.BLACK && s.status === 'playing');
    els.cardRed.classList.toggle('active', s.side === R.RED && s.status === 'playing');

    if (s.status === 'over') els.turn.textContent = t('status.gameOver');
    else {
      els.turn.textContent = t('status.withWho', {
        side: I18N.sideName(locale, s.side),
        who: t(s.side === s.humanSide ? 'who.you' : 'who.ai')
      });
    }

    els.thinking.classList.toggle('hidden', !s.thinking);
    if (s.thinking) {
      var progress = s.progress || {};
      els.thinkingText.textContent = t('status.thinking', {
        side: I18N.sideName(locale, s.side),
        level: I18N.levelName(locale, s.levelKey)
      }) + (progress.depth ? ' · ' + t('status.depthDone', { depth: progress.depth }) : '');
    }

    els.message.textContent = ui.banner ? ui.banner : I18N.formatResult(locale, s.result);
    els.message.classList.toggle('error', !!ui.banner);

    els.btnUndo.disabled = s.thinking || s.moves.length === 0;
    els.btnAgree.disabled = s.status !== 'playing' || s.thinking;
    els.btnNew.disabled = s.thinking;

    var sideButtons = document.querySelectorAll('.side-btn');
    for (var i = 0; i < sideButtons.length; i++) {
      sideButtons[i].classList.toggle('active', Number(sideButtons[i].dataset.side) === s.humanSide);
      sideButtons[i].disabled = s.thinking;
    }

    // 思考中显示实时进度，思考结束后保留上一次搜索的结果，便于复盘
    var previous = s.lastSearch;
    var shown = s.progress || (previous ? { depth: previous.depth, nodes: previous.nodes, elapsedMs: previous.elapsedMs } : null);
    var live = !!s.progress;
    els.statDepth.textContent = shown
      ? (shown.depth || 0) + ' / ' + s.levelDepth +
        (live ? ' ' + t('stat.searching', { depth: shown.currentDepth })
              : (previous ? ' (' + I18N.levelName(locale, previous.levelKey || s.levelKey) + ')' : ''))
      : (s.thinking ? '0 / ' + s.levelDepth + ' ' + t('stat.preparing') : '—');
    els.statNodes.textContent = shown ? shown.nodes.toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US') : '—';
    els.statTime.textContent = shown ? t('stat.seconds', { seconds: (shown.elapsedMs / 1000).toFixed(2) }) : '—';
    els.statScore.textContent = typeof s.lastScore === 'number' ? formatScore(s.lastScore) : '—';

    var items = [];
    for (var m = 0; m < s.moves.length; m++) {
      items.push('<li>' + escapeHtml(I18N.formatMove(locale, s.moves[m])) + '</li>');
    }
    els.moveList.innerHTML = items.join('');
    els.moveList.scrollTop = els.moveList.scrollHeight;

    var levelButtons = els.levelGrid.querySelectorAll('.level-btn');
    for (var k = 0; k < levelButtons.length; k++) {
      levelButtons[k].classList.toggle('active', Number(levelButtons[k].dataset.level) === s.level);
      levelButtons[k].disabled = false;
    }
    var key = s.levelKey;
    els.levelHint.textContent = I18N.levelName(locale, key) + ' — ' + t('level.desc.' + key);
  }

  function refresh() {
    return Promise.resolve(driver.getState()).then(function (next) {
      applyState(next);      // 局面变了会重画棋盘
      updatePanel();
      return next;
    });
  }

  // ---------------------------------------------------------------- 轮询

  var pollTimer = null;
  function poll() {
    refresh().catch(function (err) {
      ui.banner = t('conn.lost', { error: messageOf(err) });
      updatePanel();
    }).then(function () {
      var delay = state().thinking ? 120 : 300;
      pollTimer = setTimeout(poll, delay);
    });
  }

  // ---------------------------------------------------------------- 尺寸

  function resize() {
    var rect = wrap.getBoundingClientRect();
    var size = Math.max(240, Math.round(rect.width));
    view.dpr = window.devicePixelRatio || 1;
    view.scale = size / WORLD;
    canvas.width = Math.round(size * view.dpr);
    canvas.height = Math.round(size * view.dpr);
    draw();
  }

  // ---------------------------------------------------------------- 启动

  function buildLevelButtons() {
    var html = '';
    var levels = window.SurakartaAI.LEVELS;
    for (var i = 0; i < levels.length; i++) {
      html += '<button class="level-btn" data-level="' + i + '">' +
        escapeHtml(I18N.levelName(locale, levels[i].key)) +
        '<span>' + escapeHtml(t('level.depthTag', { depth: levels[i].depth })) + '</span></button>';
    }
    els.levelGrid.innerHTML = html;
    // 语言切换后只重建按钮内容，事件只绑一次，避免重复绑定
    if (!buildLevelButtons.bound) {
      buildLevelButtons.bound = true;
      els.levelGrid.addEventListener('click', function (event) {
        var btn = event.target.closest('.level-btn');
        if (!btn || btn.disabled) return;
        run(driver.setLevel(Number(btn.dataset.level)));
      });
    }
  }

  /** 语言切换按钮 */
  function buildLangSwitch() {
    els.langSwitch.innerHTML = I18N.LOCALES.map(function (l) {
      return '<button class="lang-btn" data-locale="' + l.code + '">' + escapeHtml(l.label) + '</button>';
    }).join('');
    els.langSwitch.addEventListener('click', function (event) {
      var btn = event.target.closest('.lang-btn');
      if (!btn) return;
      setLocale(btn.dataset.locale);
    });
  }

  /** 切换语言：静态文案、动态面板与画布一起刷新，选择记到 localStorage */
  function setLocale(code) {
    var next = I18N.normalize(code);
    if (next === locale) return;
    locale = next;
    ui.locale = next;
    saveLocale(next);
    applyStaticText();
    buildLevelButtons();
    updatePanel();
    draw();
  }

  /** 把 index.html 里带 data-i18n 的静态文案按当前语言填一遍 */
  function applyStaticText() {
    var nodes = document.querySelectorAll('[data-i18n]');
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].textContent = t(nodes[i].getAttribute('data-i18n'));
    }
    // #link-status 的文字取决于连上了哪种驱动，不是固定文案：
    // index.html 里的 data-i18n="conn.probing" 只是脚本就绪前的占位，
    // 这里必须按驱动再填一次，否则每次切语言都会退回「正在寻找后端服务…」。
    if (els.link && driver) els.link.textContent = t(driver.nameKey);
    document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en';
    document.title = t('app.title');
    var buttons = els.langSwitch.querySelectorAll('.lang-btn');
    for (var k = 0; k < buttons.length; k++) {
      buttons[k].classList.toggle('active', buttons[k].dataset.locale === locale);
    }
  }

  function escapeHtml(text) {
    return String(text).replace(/[&<>"]/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch];
    });
  }

  function bindSideButtons() {
    document.querySelector('.side-grid').addEventListener('click', function (event) {
      var btn = event.target.closest('.side-btn');
      if (!btn || btn.disabled) return;
      var side = Number(btn.dataset.side);
      if (side === state().humanSide) return;
      run(driver.setHumanSide(side));
    });
  }

  els.btnNew.addEventListener('click', function () { ui.banner = ''; run(driver.newGame({})); });
  els.btnUndo.addEventListener('click', function () { ui.banner = ''; run(driver.undo()); });
  els.btnAgree.addEventListener('click', function () { ui.banner = ''; run(driver.agree()); });
  window.addEventListener('resize', resize);
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(resize).observe(wrap);

  function start() {
    ui.banner = '';
    buildLangSwitch();
    applyStaticText();
    buildLevelButtons();
    bindSideButtons();
    resize();
    refresh().then(function () { poll(); })
      .catch(function (err) {
        ui.banner = t('conn.unreadable', { error: messageOf(err) });
        updatePanel();
      });
  }

  /** 探测某个地址上有没有后端服务 */
  function probe(base) {
    var timeout = new Promise(function (_, reject) {
      setTimeout(function () { reject(new Error('timeout')); }, 1200);
    });
    return Promise.race([
      fetch(base + '/api/state').then(function (res) {
        if (!res.ok) throw new Error('unavailable');
        return res.json();
      }),
      timeout
    ]).then(function (data) {
      if (!data || !data.state) throw new Error('bad state');
      return base;
    });
  }

  // 先探测后端服务；没有就退回本页直接对局（例如离线双击 index.html 打开时）。
  // 地址后面加 ?local=1 可以强制用本地对局，不去连后端。
  function detect() {
    var forceLocal = /(^|[?&])local=1(&|$)/.test(location.search) || location.hash === '#local';
    if (forceLocal) {
      driver = localDriver(Session.createSession());
      start();
      return;
    }
    var candidates = location.protocol === 'file:'
      ? ['http://127.0.0.1:8123']
      : ['', 'http://127.0.0.1:8123'];
    var chain = Promise.reject(new Error('probe'));
    candidates.forEach(function (base) {
      chain = chain.catch(function () { return probe(base); });
    });
    chain.then(function (base) {
      driver = httpDriver(base);
      start();
    }).catch(function () {
      driver = localDriver(Session.createSession());
      start();
    });
  }

  detect();

  // 调试入口：便于在控制台或自动化测试里检查局面
  window.__surakarta = {
    ui: ui,
    get game() { return ui.state; },
    get mode() { return driver === null ? 'connecting' : (driver.loadPosition ? 'local' : 'http'); },
    driver: function () { return driver; },
    refresh: refresh,
    /** 强制整幅重画（棋盘 + 面板），调试用 */
    render: function () { updatePanel(); draw(); },
    draw: draw,
    toCell: toCell,
    cellPoint: cellPoint,
    /** 直接载入局面。只有离线模式可用——在线模式下局面由后端持有。
     *  仅供控制台调试与自动化测试使用。 */
    loadPosition: function (board, side) {
      if (!driver || !driver.loadPosition) return Promise.reject(new Error(t('conn.offlineOnly')));
      ui.banner = '';
      return run(driver.loadPosition(Int8Array.from(board), side));
    },
    get locale() { return locale; },
    setLocale: setLocale,
    t: t,
    MARGIN: MARGIN,
    WORLD: WORLD,
    rules: R,
    ai: window.SurakartaAI
  };
})();
