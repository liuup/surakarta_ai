/*!
 * 苏拉卡尔塔对局会话：一局棋的完整状态机
 *
 * 这里装着「一局棋」的全部逻辑——走子、悔棋、终局判定、以及 AI 搜索的调度，
 * 但不碰 DOM、也不自己设定时器。推进 AI 搜索由调用方驱动，因此同一份逻辑可以：
 *   - 在浏览器里本地跑（双击 index.html，离线也能玩）；
 *   - 在后端服务里跑（server.js，网页与终端 TUI 共用同一局棋）。
 *
 * 调用方拿到的状态统一是 state() 返回的普通对象，可以直接 JSON 序列化。
 */
(function (global) {
  'use strict';

  function loadRules() {
    if (global.SurakartaRules) return global.SurakartaRules;
    if (typeof require === 'function') return require('./rules.js');
    throw new Error('必须先加载 js/rules.js');
  }
  function loadAI(R) {
    if (global.SurakartaAI) return global.SurakartaAI;
    if (typeof require === 'function') {
      global.SurakartaRules = R;      // ai.js 在加载时会读取全局的规则引擎
      return require('./ai.js');
    }
    throw new Error('必须先加载 js/ai.js');
  }
  function loadI18n() {
    if (global.SurakartaI18n) return global.SurakartaI18n;
    if (typeof require === 'function') return require('./i18n.js');
    throw new Error('必须先加载 js/i18n.js');
  }

  var R = loadRules();
  var AI = loadAI(R);
  var I18N = loadI18n();

  var BLACK = R.BLACK, RED = R.RED;

  function cellName(cell) { return I18N.cellName(cell, R.SIZE); }

  /*
   * 这个模块**不产生任何面向用户的文字**，只产出结构化数据：
   * 着法是 {side, from, to, capture}，终局是 {kind, winner, side, counts}，
   * 错误是 {code, params}。由各个界面按自己的语言渲染，
   * 因此网页可以看中文、终端看英文，而两边看的是同一局棋。
   */
  function failure(code, params) {
    return { ok: false, error: { code: code, params: params || {} } };
  }

  /** 按剩余子力判定胜负，返回结构化结果（不发文字） */
  function judgeByCount(counts) {
    var winner = counts.black > counts.red ? BLACK : (counts.red > counts.black ? RED : 0);
    return { winner: winner, black: counts.black, red: counts.red };
  }

  function createSession() {
    var s = {
      board: R.initialBoard(),
      side: BLACK,
      humanSide: BLACK,
      level: 1,                       // AI.LEVELS 的下标
      status: 'playing',              // playing | over
      result: null,                   // 终局的结构化描述，交由界面翻译
      history: [],                    // 悔棋用的局面快照
      moves: [],                      // 人类可读的着法记录
      lastMove: null,
      lastPath: null,                 // 最近一次吃子的绕行路线（供界面绘制）
      revision: 0,                    // 任何变化都 +1
      position: 0,                    // 只有局面/轮次/状态变化才 +1
      plan: null,                     // 进行中的 AI 搜索句柄
      progress: null,                 // 搜索进度
      lastScore: null,                // AI 最近一手的评分（供界面显示）
      lastSearch: null                // AI 最近一次搜索的统计（深度/节点/用时）
    };

    function touch(positionChanged) {
      s.revision++;
      if (positionChanged) s.position++;
    }

    function snapshot() {
      return {
        board: R.cloneBoard(s.board),
        side: s.side,
        status: s.status,
        result: s.result,
        lastMove: s.lastMove,
        lastPath: s.lastPath,
        moves: s.moves.slice()
      };
    }

    function restore(snap) {
      s.board = snap.board;
      s.side = snap.side;
      s.status = snap.status;
      s.result = snap.result;
      s.lastMove = snap.lastMove;
      s.lastPath = snap.lastPath;
      s.moves = snap.moves.slice();
      s.plan = null;
      s.progress = null;
      touch(true);
    }

    function legalMoves() {
      return R.generateMoves(s.board, s.side, false);
    }

    function checkGameEnd() {
      var counts = R.countPieces(s.board);
      if (counts.black === 0 || counts.red === 0) {
        s.status = 'over';
        s.result = { kind: 'wipeout', winner: counts.black === 0 ? RED : BLACK, counts: counts };
        return;
      }
      if (R.generateMoves(s.board, s.side, false).length === 0) {
        s.status = 'over';
        s.result = {
          kind: 'stalemate',
          side: s.side,
          counts: counts,
          judge: judgeByCount(counts)
        };
      }
    }

    /** 本局到目前为止出现过的全部局面（含当前局面），供 AI 识别重复 */
    function positionHistory() {
      var list = [];
      for (var i = 0; i < s.history.length; i++) {
        list.push(AI.hashOf(s.history[i].board, s.history[i].side));
      }
      list.push(AI.hashOf(s.board, s.side));
      return list;
    }

    /** 走一步棋。成功返回 { ok: true }，失败返回 { ok: false, error: { code, params } } */
    function playMove(move) {
      if (s.status !== 'playing') return failure('err.gameOver');
      var legal = legalMoves();
      if (legal.indexOf(move) < 0) {
        return failure('err.illegalMove', {
          from: cellName(R.moveFrom(move)),
          to: cellName(R.moveTo(move))
        });
      }
      var from = R.moveFrom(move);
      var info = null;
      var candidates = R.movesFrom(s.board, s.side, from);
      for (var i = 0; i < candidates.length; i++) {
        if (candidates[i].move === move) info = candidates[i];
      }
      var path = info && info.capture
        ? R.traceCapturePath(s.board, s.side, from, info.dir).poly
        : null;

      s.history.push(snapshot());
      var mover = s.side;
      var captured = R.applyMove(s.board, move);
      s.moves.push({
        side: mover,
        from: R.moveFrom(move),
        to: R.moveTo(move),
        capture: !!captured
      });
      s.lastMove = move;
      s.lastPath = path;
      s.side = 3 - s.side;
      checkGameEnd();
      touch(true);
      return { ok: true };
    }

    function newGame(options) {
      options = options || {};
      if (options.humanSide === BLACK || options.humanSide === RED) s.humanSide = options.humanSide;
      if (typeof options.level === 'number') s.level = clampLevel(options.level);
      s.board = R.initialBoard();
      s.side = BLACK;
      s.status = 'playing';
      s.result = null;
      s.history = [];
      s.moves = [];
      s.lastMove = null;
      s.lastPath = null;
      s.lastScore = null;
      s.lastSearch = null;
      s.plan = null;
      s.progress = null;
      touch(true);
      return state();
    }

    function clampLevel(index) {
      var i = Math.round(index);
      if (!(i >= 0)) i = 0;
      if (i > AI.LEVELS.length - 1) i = AI.LEVELS.length - 1;
      return i;
    }

    /**
     * 直接载入一个局面。供调试与测试使用——界面上没有入口，
     * 也没有对应的 HTTP 接口。载入后会立刻判定一次终局条件。
     */
    function loadPosition(board, side) {
      if (!board || board.length !== R.CELLS) {
        return failure('err.badBoard', { n: R.CELLS });
      }
      s.board = Int8Array.from(board);
      s.side = side === RED ? RED : BLACK;
      s.status = 'playing';
      s.result = null;
      s.history = [];
      s.moves = [];
      s.lastMove = null;
      s.lastPath = null;
      s.lastScore = null;
      s.lastSearch = null;
      s.plan = null;
      s.progress = null;
      checkGameEnd();
      touch(true);
      return { ok: true };
    }

    function undo() {
      if (s.history.length === 0) return failure('err.nothingToUndo');
      s.plan = null;
      s.progress = null;
      var snap = s.history.pop();
      // 一次撤回双方各一步，回到人类该走的时候
      if (snap.side !== s.humanSide && s.history.length > 0) snap = s.history.pop();
      restore(snap);
      return { ok: true };
    }

    function agreeEnd() {
      if (s.status !== 'playing') return failure('err.gameOver');
      s.plan = null;
      s.progress = null;
      s.status = 'over';
      s.result = { kind: 'agreed', counts: R.countPieces(s.board) };
      s.result.judge = judgeByCount(s.result.counts);
      touch(true);
      return { ok: true };
    }

    function setLevel(index) {
      s.level = clampLevel(index);
      touch(false);
      return { ok: true, level: s.level };
    }

    function setHumanSide(side) {
      if (side !== BLACK && side !== RED) return failure('err.badSide');
      if (side === s.humanSide) return { ok: true };
      newGame({ humanSide: side });
      return { ok: true };
    }

    /** 现在是否轮到 AI 走 */
    function needsAI() {
      return s.status === 'playing' && s.side !== s.humanSide;
    }

    function isThinking() { return s.plan !== null; }

    /** 开始为当前局面做一次 AI 搜索 */
    function startAI(options) {
      options = options || {};
      if (s.plan) return;
      if (!needsAI()) return;
      var level = AI.LEVELS[s.level];
      s.plan = AI.beginSearch(s.board, s.side, {
        depth: level.depth,
        timeMs: level.timeMs,
        nodeChunk: options.nodeChunk || 200000,
        chunkMs: options.chunkMs === undefined ? 16 : options.chunkMs,
        exactRootScores: level.exactRootScores === true,
        history: positionHistory()
      });
      s.progress = null;
      touch(false);
    }

    /**
     * 推进 AI 搜索一小段。返回 { thinking, done, progress }。
     * 调用方反复调用直到 done 为真；两次调用之间应当把控制权交还事件循环，
     * 界面才不会卡住。
     */
    function stepAI() {
      if (!s.plan) return { thinking: false, done: true, progress: null };
      var st = s.plan.step();
      if (!st.done) {
        s.progress = st;
        s.revision++;
        return { thinking: true, done: false, progress: st };
      }
      var plan = s.plan;
      s.plan = null;
      s.progress = null;
      s.lastScore = st.score;
      s.lastSearch = {
        depth: st.depth,
        nodes: st.nodes,
        elapsedMs: st.elapsedMs,
        score: st.score,
        levelKey: AI.LEVELS[s.level].key
      };
      var move = plan.pickWithNoise(AI.LEVELS[s.level]);
      if (move < 0) {                       // AI 无子可动
        checkGameEnd();
        touch(true);
        return { thinking: false, done: true, progress: null, score: st.score };
      }
      var score = st.score;
      var result = playMove(move);
      if (!result.ok) {
        // 理论上不会发生：搜索给出的着法必定在当前局面的合法着法里。
        // 万一发生了就停下对局，避免调用方反复重启搜索陷入死循环。
        s.status = 'over';
        s.result = {
          kind: 'aiError',
          error: result.error,
          from: cellName(R.moveFrom(move)),
          to: cellName(R.moveTo(move))
        };
        touch(true);
      }
      return { thinking: false, done: true, progress: null, move: move, score: score, ok: result.ok };
    }

    /** 某一枚棋子的全部合法着法，附带落脚点与绕行路线（供界面显示提示与预览） */
    function movesFrom(cell) {
      var list = R.movesFrom(s.board, s.side, cell);
      var out = [];
      for (var i = 0; i < list.length; i++) {
        var item = list[i];
        out.push({
          move: item.move,
          from: item.from,
          to: item.to,
          capture: item.capture,
          dir: item.dir,
          path: item.capture ? R.traceCapturePath(s.board, s.side, item.from, item.dir).poly : null
        });
      }
      return out;
    }

    /** 当前状态的完整快照，可直接 JSON 化后交给前端 */
    function state() {
      var counts = R.countPieces(s.board);
      var level = AI.LEVELS[s.level];
      return {
        revision: s.revision,
        position: s.position,
        board: Array.prototype.slice.call(s.board),
        side: s.side,
        humanSide: s.humanSide,
        level: s.level,
        levelKey: level.key,
        levelDepth: level.depth,
        levelCount: AI.LEVELS.length,
        // 只给语言无关的信息：档位名由各界面按自己的语言查 i18n.level.{key}
        levels: AI.LEVELS.map(function (l) { return { key: l.key, depth: l.depth }; }),
        status: s.status,
        result: s.result,
        moves: s.moves.slice(),
        counts: counts,
        lastMove: s.lastMove,
        lastPath: s.lastPath,
        lastScore: s.lastScore,
        lastSearch: s.lastSearch,
        thinking: isThinking(),
        progress: s.progress ? {
          depth: s.progress.depth,
          currentDepth: s.progress.currentDepth,
          nodes: s.progress.nodes,
          elapsedMs: s.progress.elapsedMs,
          score: s.progress.score
        } : null,
        legal: R.generateMoves(s.board, s.side, false)
      };
    }

    return {
      state: state,
      newGame: newGame,
      loadPosition: loadPosition,
      playMove: playMove,
      undo: undo,
      agreeEnd: agreeEnd,
      setLevel: setLevel,
      setHumanSide: setHumanSide,
      movesFrom: movesFrom,
      needsAI: needsAI,
      isThinking: isThinking,
      startAI: startAI,
      stepAI: stepAI,
      cellName: cellName
    };
  }

  var api = {
    createSession: createSession,
    cellName: cellName,
    judgeByCount: judgeByCount
  };

  global.SurakartaSession = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
