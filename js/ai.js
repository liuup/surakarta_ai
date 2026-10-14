/*!
 * 苏拉卡尔塔 AI：Alpha-Beta 负极大值搜索 + 置换表 + 吃子静态搜索
 *
 * 搜索以“分块”方式推进：每一步只消耗固定数量的节点，然后把控制权交还页面，
 * 因此浏览器界面在 AI 思考期间仍然可以重绘、响应交互。
 * 迭代加深的进度与置换表在分块之间保留，重复推进同一档深度时不会白费算力。
 *
 * 本文件不依赖 DOM，可同时用于浏览器与 Node 测试脚本。
 */
(function (global) {
  'use strict';

  var R = global.SurakartaRules;
  if (!R) throw new Error('必须在本文件之前加载 js/rules.js');

  var INF = 1 << 28;
  var WIN = 100000;              // 吃光对方全部棋子
  var MATE_THRESHOLD = WIN - 1000;
  var MAX_PLY = 24;

  // ---- 位置价值：角点最差，同时处在两条带环线上的交叉点最好 ----
  var POS = new Int32Array(R.CELLS);
  (function buildPos() {
    for (var r = 0; r < R.SIZE; r++) {
      for (var c = 0; c < R.SIZE; c++) {
        var lines = (r >= 1 && r <= 4 ? 1 : 0) + (c >= 1 && c <= 4 ? 1 : 0);
        POS[r * R.SIZE + c] = lines === 0 ? -12 : (lines === 1 ? 0 : 8);
      }
    }
  })();

  var W_MOBILITY = 4;   // 每个可走空点
  var W_THREAT = 30;    // 每枚当前可以直接吃子的棋子

  // 2×2 小方块内己方棋子数量的价值：棋子挤成一团聚不利于展开攻击
  // （依据 SIA 在 Computer Olympiad 上使用的 "quads" 特征，见 README 引用）
  var QUAD_VALUE = [0, 5, 2, -8, -20];

  // 主动权奖励：轮到走子的一方在苏拉卡尔塔中占据主动
  // （SIA 评估函数中的 "player to move" 特征）
  var W_TEMPO = 8;

  // ---- Zobrist 散列 ----
  var ZLO = new Int32Array(3 * R.CELLS);
  var ZHI = new Int32Array(3 * R.CELLS);
  var ZSIDE_LO = 0, ZSIDE_HI = 0;
  (function buildZobrist() {
    var seed = 0x9e3779b9 | 0;
    function nextRand() {
      seed ^= (seed << 13) | 0; seed |= 0;
      seed ^= seed >>> 17;
      seed ^= (seed << 5) | 0; seed |= 0;
      return seed;
    }
    for (var i = 0; i < ZLO.length; i++) {
      ZLO[i] = nextRand();
      ZHI[i] = nextRand();
    }
    ZSIDE_LO = nextRand();
    ZSIDE_HI = nextRand();
  })();

  // ---- 置换表 ----
  var TT_BITS = 18;
  var TT_SIZE = 1 << TT_BITS;
  var TT_MASK = TT_SIZE - 1;
  var TT_FLAG_EXACT = 0, TT_FLAG_LOWER = 1, TT_FLAG_UPPER = 2;

  function createContext() {
    var ctx = {
      board: new Int8Array(R.CELLS),
      side: R.BLACK,
      blackCount: 0,
      redCount: 0,
      hashLo: 0,
      hashHi: 0,
      nodes: 0,
      budget: 0,
      deadline: 0,
      chunkDeadline: 0,
      aborted: false,
      budgetHit: false,
      timedOut: false,
      history: new Int32Array(1 << 12),      // 以着法编码为下标（最大 36*64+63 < 4096）
      killers: new Int32Array(MAX_PLY * 2),
      lists: [],
      scores: [],
      rootMoves: new Int32Array(R.CELLS * 12 + 8),
      rootScores: new Int32Array(R.CELLS * 12 + 8),
      rootCount: 0,
      rootBest: 0,
      rootExactScores: false,
      rootScoreCur: new Int32Array(1 << 12),    // 本轮迭代各着法得分
      rootScoreFinal: new Int32Array(1 << 12),  // 上一个完整完成深度的各着法得分
      repSet: new Set()                         // 对局中已经出现过的局面
    };
    for (var i = 0; i < MAX_PLY; i++) {
      ctx.lists.push(new Int32Array(R.CELLS * 12 + 8));
      ctx.scores.push(new Int32Array(R.CELLS * 12 + 8));
    }
    return ctx;
  }

  var ttKeyLo = new Int32Array(TT_SIZE);
  var ttKeyHi = new Int32Array(TT_SIZE);
  var ttData = new Int32Array(TT_SIZE);
  var ttScore = new Int32Array(TT_SIZE);

  var ctx = createContext();
  var qsearchLimit = 4;

  function countOf(c, side) { return side === R.BLACK ? c.blackCount : c.redCount; }

  /** 把 64 位的 Zobrist 散列折叠成一个 32 位整数，用于重复局面的集合查表 */
  function repKey(lo, hi) { return (lo ^ Math.imul(hi, 0x9e3779b1)) | 0; }

  /**
   * 刚走完一步之后的局面是否在本局此前出现过。
   *
   * 折算必须落在**真实搜索分值**上，而不能在重复局面处截断成静态评估：
   * 那样等于把「重复」定价成一个固定的静态分，评估偏乐观时反而会诱导 AI 去重复。
   */
  function isRepeat(c) {
    return c.repSet.size !== 0 && c.repSet.has(repKey(c.hashLo, c.hashHi));
  }

  /**
   * 走回旧局面的分值折算：至多算作一个和棋（0 分），必杀分不受影响。
   * 这样占优的一方不会原地打转去重复局面，落后的一方也不会为了拖延而故意重复
   * ——后者是因为负分本来就已经低于 0，折算不会带来任何好处。
   *
   * 只在**根节点**（searchRoot）调用。搜索树内部不做折算，是为了让置换表里
   * 存的分值只取决于局面本身：置换表会跨搜索、跨对局一直复用，一旦掺进
   * 「哪些局面走过」这种对局历史，缓存下来的分值就不再可信了。
   */
  function applyRepeatPenalty(score) {
    return (score > 0 && score < MATE_THRESHOLD) ? 0 : score;
  }

  /** 计算某个局面的散列（供界面记录对局历史、以及重复局面检测使用） */
  function hashOf(board, side) { return computeHash(board, side); }

  function computeHash(board, side) {
    var lo = 0, hi = 0;
    for (var cell = 0; cell < R.CELLS; cell++) {
      var p = board[cell];
      if (p === 0) continue;
      lo ^= ZLO[p * R.CELLS + cell];
      hi ^= ZHI[p * R.CELLS + cell];
    }
    if (side === R.RED) { lo ^= ZSIDE_LO; hi ^= ZSIDE_HI; }
    return { lo: lo, hi: hi };
  }

  function makeMove(c, move) {
    var from = move >> 6, to = move & 63;
    var b = c.board;
    var piece = b[from];
    var captured = b[to];
    b[from] = 0;
    b[to] = piece;
    var lo = c.hashLo ^ ZLO[piece * R.CELLS + from] ^ ZLO[piece * R.CELLS + to];
    var hi = c.hashHi ^ ZHI[piece * R.CELLS + from] ^ ZHI[piece * R.CELLS + to];
    if (captured !== 0) {
      lo ^= ZLO[captured * R.CELLS + to];
      hi ^= ZHI[captured * R.CELLS + to];
      if (captured === R.BLACK) c.blackCount--; else c.redCount--;
    }
    c.hashLo = lo ^ ZSIDE_LO;
    c.hashHi = hi ^ ZSIDE_HI;
    c.side = 3 - c.side;
    return captured;
  }

  function unmakeMove(c, move, captured) {
    var from = move >> 6, to = move & 63;
    var b = c.board;
    var piece = b[to];
    b[to] = captured;
    b[from] = piece;
    var lo = c.hashLo ^ ZLO[piece * R.CELLS + from] ^ ZLO[piece * R.CELLS + to];
    var hi = c.hashHi ^ ZHI[piece * R.CELLS + from] ^ ZHI[piece * R.CELLS + to];
    if (captured !== 0) {
      lo ^= ZLO[captured * R.CELLS + to];
      hi ^= ZHI[captured * R.CELLS + to];
      if (captured === R.BLACK) c.blackCount++; else c.redCount++;
    }
    c.hashLo = lo ^ ZSIDE_LO;
    c.hashHi = hi ^ ZSIDE_HI;
    c.side = 3 - c.side;
  }

  function nowMs() {
    return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
  }

  /** 某一方当前有多少枚棋子可以直接吃子（威胁数） */
  function countThreats(board, side) {
    var total = 0;
    for (var from = 0; from < R.CELLS; from++) {
      if (board[from] !== side) continue;
      for (var d = 0; d < 4; d++) {
        if (R.walkCapture(board, side, from, d) >= 0) { total++; break; }
      }
    }
    return total;
  }

  /** 从走子方视角给出的静态评分 */
  function evaluate(c) {
    var b = c.board, side = c.side, opp = 3 - side;
    var score = 0;
    for (var cell = 0; cell < R.CELLS; cell++) {
      var p = b[cell];
      if (p === 0) continue;
      var sign = p === side ? 1 : -1;
      var r = (cell / R.SIZE) | 0, col = cell % R.SIZE;
      var mobility = 0;
      for (var k = 0; k < 8; k++) {
        var nr = r + R.STEP_DR[k], nc = col + R.STEP_DC[k];
        if (!R.inBoard(nr, nc)) continue;
        if (b[nr * R.SIZE + nc] === 0) mobility++;
      }
      score += sign * (100 + POS[cell] + mobility * W_MOBILITY);
    }
    score += W_THREAT * (countThreats(b, side) - countThreats(b, opp));

    // 2×2 小方块中的棋子分布
    for (var qr = 0; qr < R.SIZE - 1; qr++) {
      for (var qc = 0; qc < R.SIZE - 1; qc++) {
        var mine = 0, theirs = 0;
        for (var dr = 0; dr < 2; dr++) {
          for (var dc = 0; dc < 2; dc++) {
            var value = b[(qr + dr) * R.SIZE + qc + dc];
            if (value === side) mine++;
            else if (value === opp) theirs++;
          }
        }
        score += QUAD_VALUE[mine] - QUAD_VALUE[theirs];
      }
    }
    return score + W_TEMPO;
  }

  function scoreToTT(s, ply) {
    if (s >= MATE_THRESHOLD) return s + ply;
    if (s <= -MATE_THRESHOLD) return s - ply;
    return s;
  }
  function scoreFromTT(s, ply) {
    if (s >= MATE_THRESHOLD) return s - ply;
    if (s <= -MATE_THRESHOLD) return s + ply;
    return s;
  }

  /**
   * 每 1024 个节点检查一次是否该停下来。
   * - 到达总时限：本次搜索结束，保留上一个完整深度的结果（timedOut）。
   * - 用完本段节点预算或本段的时间配额：只是让出主线程，稍后继续同一档（budgetHit）。
   */
  function checkAbort(c) {
    if ((++c.nodes & 1023) === 0) {
      if (c.nodes >= c.budget) { c.aborted = true; c.budgetHit = true; return true; }
      var t = nowMs();
      if (t >= c.deadline) { c.aborted = true; c.timedOut = true; return true; }
      if (t >= c.chunkDeadline) { c.aborted = true; c.budgetHit = true; return true; }
    }
    return false;
  }

  /** 吃子静态搜索：只延伸吃子着法，深度有限 */
  function quiesce(c, alpha, beta, ply, depthLeft) {
    if (checkAbort(c)) return 0;
    var side = c.side, opp = 3 - side;
    var standPat = evaluate(c);
    if (standPat >= beta) return standPat;
    if (standPat > alpha) alpha = standPat;
    if (depthLeft <= 0 || ply >= MAX_PLY - 1) return alpha;
    var list = c.lists[ply];
    var n = R.genCaptureMoves(c.board, side, list, 0);
    for (var i = 0; i < n; i++) {
      var move = list[i];
      var capturedPiece = makeMove(c, move);
      var score;
      if (countOf(c, opp) === 0) score = WIN - ply;
      else {
        score = -quiesce(c, -beta, -alpha, ply + 1, depthLeft - 1);
      }
      unmakeMove(c, move, capturedPiece);
      if (c.aborted) return 0;
      if (score > alpha) {
        alpha = score;
        if (alpha >= beta) return alpha;
      }
    }
    return alpha;
  }

  function negamax(c, depth, alpha, beta, ply) {
    if (checkAbort(c)) return 0;
    var side = c.side, opp = 3 - side;
    if (countOf(c, side) === 0) return -(WIN - ply);
    if (ply >= MAX_PLY - 1) return evaluate(c);

    var alphaOrig = alpha;
    var index = c.hashLo & TT_MASK;
    var ttMove = 0;
    if (ttKeyLo[index] === c.hashLo && ttKeyHi[index] === c.hashHi) {
      var data = ttData[index];
      var ttDepth = (data >>> 12) & 63;
      if (ttDepth >= depth) {
        var ttFlag = (data >>> 18) & 3;
        var ttVal = scoreFromTT(ttScore[index], ply);
        if (ttFlag === TT_FLAG_EXACT) return ttVal;
        if (ttFlag === TT_FLAG_LOWER && ttVal > alpha) alpha = ttVal;
        else if (ttFlag === TT_FLAG_UPPER && ttVal < beta) beta = ttVal;
        if (alpha >= beta) return ttVal;
      }
      ttMove = data & 4095;
    }

    if (depth <= 0) return quiesce(c, alpha, beta, ply, qsearchLimit);

    var list = c.lists[ply];
    var n = R.genCaptureMoves(c.board, side, list, 0);
    var captureCount = n;
    n = R.genQuietMoves(c.board, side, list, n);
    if (n === 0) {
      var my = countOf(c, side), other = countOf(c, opp);
      if (my > other) return WIN - ply - 1;
      if (my < other) return -(WIN - ply - 1);
      return 0;
    }

    var scores = c.scores[ply];
    var killerA = c.killers[ply * 2], killerB = c.killers[ply * 2 + 1];
    for (var i = 0; i < n; i++) {
      var m = list[i];
      if (m === ttMove) scores[i] = 1 << 30;
      else if (i < captureCount) scores[i] = (1 << 28) + (n - i);
      else if (m === killerA) scores[i] = (1 << 27);
      else if (m === killerB) scores[i] = (1 << 27) - 1;
      else scores[i] = c.history[m];
    }

    var bestScore = -INF, bestMove = 0;
    for (var done = 0; done < n; done++) {
      var best = done;
      for (var j = done + 1; j < n; j++) if (scores[j] > scores[best]) best = j;
      if (best !== done) {
        var tmp = list[done]; list[done] = list[best]; list[best] = tmp;
        var ts = scores[done]; scores[done] = scores[best]; scores[best] = ts;
      }
      var move = list[done];
      // 注意不能用 done < captureCount 判断：排序会把吃子着法挪位置。
      // 此处的棋盘已经恢复成本节点的原状，因此看落点是否被占即可。
      var isCapture = c.board[move & 63] !== 0;
      var capturedPiece = makeMove(c, move);
      var score;
      if (countOf(c, opp) === 0) {
        score = WIN - ply;
      } else {
        score = -negamax(c, depth - 1, -beta, -alpha, ply + 1);
      }
      unmakeMove(c, move, capturedPiece);
      if (c.aborted) return 0;
      if (score > bestScore) { bestScore = score; bestMove = move; }
      if (score > alpha) alpha = score;
      if (alpha >= beta) {
        if (!isCapture) {
          if (c.killers[ply * 2] !== move) {
            c.killers[ply * 2 + 1] = c.killers[ply * 2];
            c.killers[ply * 2] = move;
          }
          c.history[move] += depth * depth;
        }
        break;
      }
    }

    var flag = bestScore <= alphaOrig ? TT_FLAG_UPPER : (bestScore >= beta ? TT_FLAG_LOWER : TT_FLAG_EXACT);
    ttKeyLo[index] = c.hashLo;
    ttKeyHi[index] = c.hashHi;
    ttData[index] = bestMove | (depth << 12) | (flag << 18);
    ttScore[index] = scoreToTT(bestScore, ply);
    return bestScore;
  }

  /** 搜索一档深度；节点预算或时间用尽时中断 */
  function searchRoot(c, depth) {
    var side = c.side, opp = 3 - side;
    var n = c.rootCount;
    var moves = c.rootMoves, scores = c.rootScores;
    var fullWindow = c.rootExactScores;
    for (var i = 0; i < n; i++) {
      var m = moves[i];
      if (m === c.rootBest) scores[i] = 1 << 30;
      else if (c.board[m & 63] !== 0) scores[i] = (1 << 28) + (n - i);
      else scores[i] = c.history[m] + (n - i);
    }
    var alpha = -INF;
    var bestMove = 0, bestScore = -INF, bestRawScore = 0;
    c.rootScoreCur.fill(-INF);
    for (var done = 0; done < n; done++) {
      var best = done;
      for (var j = done + 1; j < n; j++) if (scores[j] > scores[best]) best = j;
      if (best !== done) {
        var tmp = moves[done]; moves[done] = moves[best]; moves[best] = tmp;
        var ts = scores[done]; scores[done] = scores[best]; scores[best] = ts;
      }
      var move = moves[done];
      var capturedPiece = makeMove(c, move);
      var score;
      if (countOf(c, opp) === 0) score = WIN;
      else {
        if (fullWindow) score = -negamax(c, depth - 1, -INF, INF, 1);
        else score = -negamax(c, depth - 1, -INF, -alpha, 1);
      }
      // 重复折算只在这里做，搜索树内部不做：树内一旦掺进对局历史，
      // 置换表里存的分值就不再只取决于局面本身了。
      var raw = score;
      var effective = isRepeat(c) ? applyRepeatPenalty(score) : score;
      unmakeMove(c, move, capturedPiece);
      if (c.aborted) return { move: 0, score: 0, aborted: true };
      c.rootScoreCur[move] = effective;
      if (effective > bestScore) { bestScore = effective; bestMove = move; bestRawScore = raw; }
      if (effective > alpha) alpha = effective;
    }
    var index = c.hashLo & TT_MASK;
    ttKeyLo[index] = c.hashLo;
    ttKeyHi[index] = c.hashHi;
    ttData[index] = bestMove | (depth << 12) | (TT_FLAG_EXACT << 18);
    ttScore[index] = scoreToTT(bestRawScore, 0);   // 存未经折算的真实分值
    return { move: bestMove, score: bestScore, aborted: false, rawScore: bestRawScore };
  }

  var LEVELS = [
    { key: 1, name: '入门', depth: 2, timeMs: 600, blunder: 60, exactRootScores: true },
    { key: 2, name: '进阶', depth: 4, timeMs: 1500, blunder: 25, exactRootScores: true },
    { key: 3, name: '高手', depth: 6, timeMs: 4000, blunder: 0, exactRootScores: false },
    { key: 4, name: '大师', depth: 8, timeMs: 10000, blunder: 0, exactRootScores: false }
  ];

  /**
   * 开始一次搜索，返回可以分块推进的句柄。
   * 调用方反复执行 handle.step()，每次执行一小段搜索，直到 done 为真。
   */
  function beginSearch(board, side, options) {
    var c = ctx;
    c.board.set(board);
    c.side = side;
    var counts = R.countPieces(board);
    c.blackCount = counts.black;
    c.redCount = counts.red;
    var hash = computeHash(c.board, side);
    c.hashLo = hash.lo;
    c.hashHi = hash.hi;
    c.nodes = 0;
    c.aborted = false;
    c.budgetHit = false;
    c.timedOut = false;
    c.rootBest = 0;
    c.history.fill(0);
    c.killers.fill(0);

    c.repSet.clear();
    var seen = options.history;
    if (seen) {
      for (var s = 0; s < seen.length; s++) c.repSet.add(repKey(seen[s].lo, seen[s].hi));
    }

    var maxDepth = options.depth;
    var deadline = nowMs() + options.timeMs;
    var chunk = options.nodeChunk || 12000;                       // 单段节点上限（兜底）
    var chunkMs = options.chunkMs === undefined ? 0 : options.chunkMs;  // 单段时长上限
    var quiesceDepth = options.quiesceDepth === undefined ? 4 : options.quiesceDepth;
    qsearchLimit = quiesceDepth;
    c.rootExactScores = options.exactRootScores === true;
    c.deadline = deadline;

    c.rootCount = R.genCaptureMoves(c.board, side, c.rootMoves, 0);
    c.rootCount = R.genQuietMoves(c.board, side, c.rootMoves, c.rootCount);

    var depth = 1;
    // 先指向排在最前面的合法着法，而不是 0：0 不是合法着法，
    // 万一调用方在第一个深度搜完之前就来取着法，也会拿到一步能走的棋。
    var bestMove = c.rootCount > 0 ? c.rootMoves[0] : -1;
    var bestScore = 0, completedDepth = 0;
    var nodesTotal = 0;
    var done = false;
    var startedAt = nowMs();
    var currentDepth = 0;

    function step() {
      if (!done) {
        while (true) {
          if (c.rootCount === 0) { done = true; bestMove = -1; break; }
          if (depth > maxDepth) { done = true; break; }
          if (nowMs() >= deadline && completedDepth > 0) { done = true; break; }
          c.nodes = 0;
          c.aborted = false;
          c.budgetHit = false;
          c.timedOut = false;
          c.budget = chunk;
          c.chunkDeadline = chunkMs > 0 ? nowMs() + chunkMs : Infinity;
          currentDepth = depth;
          var res = searchRoot(c, depth);
          nodesTotal += c.nodes;
          if (c.timedOut) { done = true; break; }
          if (c.aborted) {
            if (nowMs() >= deadline) { done = true; break; }
            break;                       // 仅是用完本段节点预算，让出主线程后继续同一档
          }
          if (res.move !== 0) {
            bestMove = res.move;
            bestScore = res.score;
            completedDepth = depth;
            c.rootBest = res.move;
            var swap = c.rootScoreFinal;
            c.rootScoreFinal = c.rootScoreCur;
            c.rootScoreCur = swap;
          }
          if (Math.abs(bestScore) >= MATE_THRESHOLD) { done = true; break; }
          depth++;
        }
      }
      if (done && bestMove === 0) {
        bestMove = c.rootCount > 0 ? c.rootMoves[0] : -1;   // 兜底：用排序最靠前的合法着法
      }
      return {
        done: done,
        move: bestMove,
        score: bestScore,
        depth: completedDepth,
        currentDepth: currentDepth,
        nodes: nodesTotal,
        elapsedMs: nowMs() - startedAt
      };
    }

    return {
      step: step,
      /** 低难度档允许在评分接近的着法里随机挑一个，避免每盘一模一样。
       *  只有在根节点用全窗口搜索（exactRootScores）时各着法分值才是精确值，
       *  否则不做筛选，直接使用搜索结果。 */
      pickWithNoise: function (level) {
        var blunder = level.blunder || 0;
        if (blunder <= 0 || bestMove <= 0 || c.rootCount <= 1) return bestMove;
        if (!c.rootExactScores) return bestMove;
        var scores = c.rootScoreFinal;
        var best = scores[bestMove];
        if (best <= -MATE_THRESHOLD) return bestMove;      // 已是必败局面，不必再加噪声
        var pool = [];
        for (var i = 0; i < c.rootCount; i++) {
          var m = c.rootMoves[i];
          var s = scores[m];
          if (s <= -MATE_THRESHOLD) continue;
          if (s >= best - blunder) pool.push(m);
        }
        if (pool.length <= 1) return bestMove;
        return pool[Math.floor(Math.random() * pool.length)];
      },
      info: function () {
        return { move: bestMove, score: bestScore, depth: completedDepth, nodes: nodesTotal };
      },
      /** 上一个完整完成深度的各根着法分值。只有在 exactRootScores 为真时才是精确值，
       *  否则只有最优着法的分值是可靠的。主要供测试与排查使用。 */
      rootScores: function () {
        var list = [];
        for (var i = 0; i < c.rootCount; i++) {
          var m = c.rootMoves[i];
          list.push({ move: m, score: c.rootScoreFinal[m] });
        }
        return list;
      }
    };
  }

  /** 从走子方视角评估给定局面（供测试与调试使用） */
  function evaluateBoard(board, side) {
    var savedBoard = ctx.board;
    var savedSide = ctx.side;
    ctx.board = board;
    ctx.side = side;
    var value = evaluate(ctx);
    ctx.board = savedBoard;
    ctx.side = savedSide;
    return value;
  }

  function clearTable() {
    ttKeyLo.fill(0);
    ttKeyHi.fill(0);
    ttData.fill(0);
    ttScore.fill(0);
  }

  var api = {
    LEVELS: LEVELS,
    WIN: WIN,
    beginSearch: beginSearch,
    hashOf: hashOf,
    clearTable: clearTable,
    evaluateBoard: evaluateBoard
  };

  global.SurakartaAI = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
