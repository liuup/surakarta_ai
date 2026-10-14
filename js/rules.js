/*!
 * 苏拉卡尔塔（Surakarta）规则引擎
 *
 * 棋盘：6×6 交叉点，每方 12 枚棋子。
 * 棋盘线的编号（行 r 自上而下 0..5，列 c 自左至右 0..5）：
 *   第 0、5 行与第 0、5 列是最外侧的线，上面没有环；
 *   第 1、4 行与第 1、4 列属于内侧回路（配第 1 圈的三个四分之一圆环）；
 *   第 2、3 行与第 2、3 列属于外侧回路（配第 2 圈的三个四分之一圆环）。
 *
 * 八个角环的几何：以四个角点为圆心、半径分别为 1 格和 2 格作圆，
 * 每个圆与棋盘线相切的两个交叉点构成一个环（共 4 角 × 2 圈 = 8 个环）。
 * 该圆落在棋盘内的四分之一与棋盘线重合，真正构成环的是棋盘外的四分之三圆弧。
 *
 * 吃子路径：从起点沿所在的行或列直线前进，经过的点必须全部为空；
 * 走到没有环的尽头则路径终止；走到有环的尽头则沿环切向离开棋盘、
 * 绕过四分之三圆环，从相邻的另一条线的端点切向回到棋盘，方向随之转过 90°。
 * 至少要绕过 1 个环，才允许落在路径上遇到的第一枚敌方棋子上完成吃子。
 *
 * 本文件不依赖 DOM，可同时用于浏览器与 Node 测试脚本。
 */
(function (global) {
  'use strict';

  var SIZE = 6;
  var CELLS = SIZE * SIZE;
  var EMPTY = 0, BLACK = 1, RED = 2;

  // 普通走子：八邻域
  var STEP_DR = [-1, -1, -1, 0, 0, 1, 1, 1];
  var STEP_DC = [-1, 0, 1, -1, 1, -1, 0, 1];

  // 吃子行进方向：沿行/列的四条直线方向
  var DIR_RIGHT = 0, DIR_LEFT = 1, DIR_DOWN = 2, DIR_UP = 3;
  var LINE_DR = [0, 0, 1, -1];
  var LINE_DC = [1, -1, 0, 0];

  function rowOf(cell) { return (cell / SIZE) | 0; }
  function colOf(cell) { return cell % SIZE; }
  function idx(r, c) { return r * SIZE + c; }
  function inBoard(r, c) { return r >= 0 && r < SIZE && c >= 0 && c < SIZE; }

  // 处在棋盘边上的环端点，绕环回棋盘时的内向方向由所在边唯一确定
  function inwardDir(cell) {
    var r = rowOf(cell), c = colOf(cell);
    if (r === 0) return DIR_DOWN;
    if (r === SIZE - 1) return DIR_UP;
    if (c === 0) return DIR_RIGHT;
    return DIR_LEFT;
  }

  var LOOP_PARTNER = new Int8Array(CELLS).fill(-1);   // 环的另一端交叉点
  var LOOP_EXIT_DIR = new Int8Array(CELLS).fill(-1);  // 从环回到棋盘时的行进方向
  var LOOP_CIRCLE_OF = new Int8Array(CELLS).fill(-1); // 所属圆环编号 0..7
  var CIRCLES = [];                                   // 每个环的圆心、半径、两个端点

  (function buildLoops() {
    var id = 0;
    var corners = [[0, 0], [0, SIZE - 1], [SIZE - 1, 0], [SIZE - 1, SIZE - 1]];
    var radii = [1, 2];
    for (var ci = 0; ci < corners.length; ci++) {
      var cr = corners[ci][0], cc = corners[ci][1];
      for (var ri = 0; ri < radii.length; ri++) {
        var radius = radii[ri];
        var pts = [];
        if (cc + radius < SIZE) pts.push(idx(cr, cc + radius));
        if (cc - radius >= 0) pts.push(idx(cr, cc - radius));
        if (cr + radius < SIZE) pts.push(idx(cr + radius, cc));
        if (cr - radius >= 0) pts.push(idx(cr - radius, cc));
        if (pts.length !== 2) {
          throw new Error('角环几何构造异常：角(' + cr + ',' + cc + ') 半径 ' + radius + ' 得到 ' + pts.length + ' 个端点');
        }
        var a = pts[0], b = pts[1];
        LOOP_PARTNER[a] = b;
        LOOP_PARTNER[b] = a;
        LOOP_CIRCLE_OF[a] = id;
        LOOP_CIRCLE_OF[b] = id;
        LOOP_EXIT_DIR[a] = inwardDir(a);
        LOOP_EXIT_DIR[b] = inwardDir(b);
        CIRCLES.push({ id: id, cr: cr, cc: cc, radius: radius, a: a, b: b, inner: radius === 1 });
        id++;
      }
    }
  })();

  // 直线两端有环的线（内侧回路与外侧回路）
  var INNER_LINES = [1, 4];
  var OUTER_LINES = [2, 3];

  /*
   * 绕行路径的循环检测：每一趟绕行领一个「代数」，走过哪个 (交叉点, 方向)
   * 就在 visitStamp 里记下代数；再走到同一个格子且方向相同时，代数相等即说明
   * 前方再无障碍，可以收工。这样每趟绕行不必清空数组，代价只是一次比较。
   *
   * 这里必须是 Float64Array，不能用 Int32Array：代数在**整个进程生命周期内**单调递增
   * （AI 每搜一个节点就要绕行几十次），过一会儿就会超过 2^31。用 Int32Array 存的话
   * 写入时会被悄悄截断成负数，而读回来的 gen 仍是正数，`stamp === gen` 从此永不成立——
   * 保护失效，walkCapture 会真的转不出来，表现为 AI 搜索卡死、CPU 100%、棋再也走不动。
   * Float64Array 能精确表示到 2^53，这个失败模式就不存在了。
   */
  var visitStamp = new Float64Array(CELLS * 4);
  var visitGen = 0;

  function initialBoard() {
    var b = new Int8Array(CELLS);
    for (var c = 0; c < SIZE; c++) {
      b[idx(0, c)] = BLACK;
      b[idx(1, c)] = BLACK;
      b[idx(4, c)] = RED;
      b[idx(5, c)] = RED;
    }
    return b;
  }

  function cloneBoard(board) { return Int8Array.from(board); }

  function countPieces(board) {
    var black = 0, red = 0;
    for (var i = 0; i < CELLS; i++) {
      if (board[i] === BLACK) black++;
      else if (board[i] === RED) red++;
    }
    return { black: black, red: red };
  }

  function packMove(from, to) { return (from << 6) | to; }
  function moveFrom(move) { return move >> 6; }
  function moveTo(move) { return move & 63; }

  /**
   * 沿 from 所在直线朝 dir 方向搜索一次吃子机会。
   * 返回可以吃掉的敌子位置，没有合法吃子时返回 -1。
   */
  function walkCapture(board, side, from, dir) {
    var cur = from, d = dir, loops = 0;
    var gen = ++visitGen;
    for (;;) {
      var nr = rowOf(cur) + LINE_DR[d];
      var nc = colOf(cur) + LINE_DC[d];
      var next;
      if (inBoard(nr, nc)) {
        next = nr * SIZE + nc;
      } else {
        var partner = LOOP_PARTNER[cur];
        if (partner < 0) return -1;          // 走到没有环的线头，路径终止
        next = partner;
        d = LOOP_EXIT_DIR[partner];
        loops++;
      }
      // 起点在棋子离开后即为空点，重新经过时不算阻挡
      var occupant = (next === from) ? EMPTY : board[next];
      if (occupant !== EMPTY) {
        if (occupant !== side && loops > 0) return next;
        return -1;                            // 己方棋子或未绕环即遇到棋子
      }
      cur = next;
      var key = cur * 4 + d;
      if (visitStamp[key] === gen) return -1; // 同一条线路重复出现，说明前方再无障碍
      visitStamp[key] = gen;
    }
  }

  /**
   * 生成所有普通走子（八邻域走到空点）。
   */
  function genQuietMoves(board, side, out, start) {
    var n = start;
    for (var from = 0; from < CELLS; from++) {
      if (board[from] !== side) continue;
      var r = rowOf(from), c = colOf(from);
      for (var k = 0; k < 8; k++) {
        var nr = r + STEP_DR[k], nc = c + STEP_DC[k];
        if (!inBoard(nr, nc)) continue;
        var to = nr * SIZE + nc;
        if (board[to] === EMPTY) out[n++] = packMove(from, to);
      }
    }
    return n;
  }

  /**
   * 生成所有吃子着法。每枚棋子至多四条直线方向，
   * 不同方向可能到达同一个目标，需要去重。
   */
  var captureTargets = new Int32Array(4);

  function genCaptureMoves(board, side, out, start) {
    var n = start;
    for (var from = 0; from < CELLS; from++) {
      if (board[from] !== side) continue;
      var found = 0;
      for (var d = 0; d < 4; d++) {
        var to = walkCapture(board, side, from, d);
        if (to < 0) continue;
        var duplicate = false;
        for (var k = 0; k < found; k++) {
          if (captureTargets[k] === to) { duplicate = true; break; }
        }
        if (duplicate) continue;
        captureTargets[found++] = to;
        out[n++] = packMove(from, to);
      }
    }
    return n;
  }

  var scratch = new Int32Array(CELLS * 12);

  function generateMoves(board, side, capturesOnly) {
    var n;
    if (capturesOnly) {
      n = genCaptureMoves(board, side, scratch, 0);
    } else {
      n = genCaptureMoves(board, side, scratch, 0);
      n = genQuietMoves(board, side, scratch, n);
    }
    var list = new Array(n);
    for (var i = 0; i < n; i++) list[i] = scratch[i];
    return list;
  }

  /** 某枚棋子的全部合法着法，附带供界面使用的信息 */
  function movesFrom(board, side, from) {
    var result = [];
    if (board[from] !== side) return result;
    var r = rowOf(from), c = colOf(from);
    for (var k = 0; k < 8; k++) {
      var nr = r + STEP_DR[k], nc = c + STEP_DC[k];
      if (!inBoard(nr, nc)) continue;
      var to = nr * SIZE + nc;
      if (board[to] === EMPTY) {
        result.push({ move: packMove(from, to), from: from, to: to, capture: false, dir: -1 });
      }
    }
    var seen = [];
    for (var d = 0; d < 4; d++) {
      var target = walkCapture(board, side, from, d);
      if (target < 0 || seen.indexOf(target) >= 0) continue;
      seen.push(target);
      result.push({ move: packMove(from, target), from: from, to: target, capture: true, dir: d });
    }
    return result;
  }

  /** 落子（原地修改棋盘），返回被吃掉的棋子（0 表示没有吃子） */
  function applyMove(board, move) {
    var from = moveFrom(move), to = moveTo(move);
    var piece = board[from];
    var captured = board[to];
    board[from] = EMPTY;
    board[to] = piece;
    return captured;
  }

  /**
   * 追踪一条吃子路径，供界面绘制。
   * 返回 { to, poly }，poly 是以格为单位的多段线（x 为列、y 为行，圆弧处为小数）。
   */
  function traceCapturePath(board, side, from, dir) {
    var poly = [{ x: colOf(from), y: rowOf(from) }];
    var cur = from, d = dir, loops = 0;
    var gen = ++visitGen;
    var guard = 0;
    for (;;) {
      if (++guard > 512) throw new Error('吃子路径追踪未收敛');
      var nr = rowOf(cur) + LINE_DR[d];
      var nc = colOf(cur) + LINE_DC[d];
      var next;
      if (inBoard(nr, nc)) {
        next = nr * SIZE + nc;
      } else {
        var partner = LOOP_PARTNER[cur];
        if (partner < 0) return { to: -1, poly: poly };
        appendArc(poly, cur, partner);
        loops++;
        next = partner;
        d = LOOP_EXIT_DIR[partner];
      }
      poly.push({ x: colOf(next), y: rowOf(next) });
      var occupant = (next === from) ? EMPTY : board[next];
      if (occupant !== EMPTY) {
        if (occupant !== side && loops > 0) return { to: next, poly: poly };
        return { to: -1, poly: poly };
      }
      cur = next;
      var key = cur * 4 + d;
      if (visitStamp[key] === gen) return { to: -1, poly: poly };
      visitStamp[key] = gen;
    }
  }

  /** 采样一个角环的圆弧，返回棋盘外四分之三圆的折线点（供界面绘制） */
  function loopArcPoints(circle, steps) {
    steps = steps || 28;
    var twoPi = Math.PI * 2;
    var a1 = Math.atan2(rowOf(circle.a) - circle.cr, colOf(circle.a) - circle.cc);
    var a2 = Math.atan2(rowOf(circle.b) - circle.cr, colOf(circle.b) - circle.cc);
    var aMid = Math.atan2(circle.cr === 0 ? -1 : 1, circle.cc === 0 ? -1 : 1);
    var delta = ((a2 - a1) % twoPi + twoPi) % twoPi;
    var toMid = ((aMid - a1) % twoPi + twoPi) % twoPi;
    var sweep = toMid < delta ? delta : delta - twoPi;
    var pts = [];
    for (var i = 0; i <= steps; i++) {
      var angle = a1 + sweep * (i / steps);
      pts.push({
        x: circle.cc + circle.radius * Math.cos(angle),
        y: circle.cr + circle.radius * Math.sin(angle)
      });
    }
    return pts;
  }

  /** 把绕环的四分之三圆弧采样进多段线 */
  function appendArc(poly, a, b) {
    var circle = CIRCLES[LOOP_CIRCLE_OF[a]];
    var pts = loopArcPoints(circle, 20);
    var forward = LOOP_PARTNER[circle.a] === circle.b && circle.a === a;
    if (forward) {
      for (var i = 1; i < pts.length - 1; i++) poly.push(pts[i]);
    } else {
      for (var j = pts.length - 2; j >= 1; j--) poly.push(pts[j]);
    }
  }

  function boardToString(board) {
    var rows = [];
    for (var r = 0; r < SIZE; r++) {
      var line = '';
      for (var c = 0; c < SIZE; c++) {
        var v = board[idx(r, c)];
        line += v === EMPTY ? '.' : (v === BLACK ? 'B' : 'R');
      }
      rows.push(line);
    }
    return rows.join('\n');
  }

  /**
   * 仅供测试：把绕行的代数计数器设到指定值。
   * 真实使用中这个数会涨到 20 多亿（AI 每搜一个节点就绕行几十次），
   * 靠真跑满这么多趟来验证溢出行为不现实，所以留一个入口给用例。
   */
  function setVisitGenForTest(value) { visitGen = value; }

  var api = {
    SIZE: SIZE,
    CELLS: CELLS,
    EMPTY: EMPTY,
    BLACK: BLACK,
    RED: RED,
    DIR_RIGHT: DIR_RIGHT,
    DIR_LEFT: DIR_LEFT,
    DIR_DOWN: DIR_DOWN,
    DIR_UP: DIR_UP,
    LINE_DR: LINE_DR,
    LINE_DC: LINE_DC,
    STEP_DR: STEP_DR,
    STEP_DC: STEP_DC,
    LOOP_PARTNER: LOOP_PARTNER,
    LOOP_EXIT_DIR: LOOP_EXIT_DIR,
    LOOP_CIRCLE_OF: LOOP_CIRCLE_OF,
    CIRCLES: CIRCLES,
    INNER_LINES: INNER_LINES,
    OUTER_LINES: OUTER_LINES,
    rowOf: rowOf,
    colOf: colOf,
    idx: idx,
    inBoard: inBoard,
    initialBoard: initialBoard,
    cloneBoard: cloneBoard,
    countPieces: countPieces,
    packMove: packMove,
    moveFrom: moveFrom,
    moveTo: moveTo,
    walkCapture: walkCapture,
    genQuietMoves: genQuietMoves,
    genCaptureMoves: genCaptureMoves,
    generateMoves: generateMoves,
    movesFrom: movesFrom,
    applyMove: applyMove,
    traceCapturePath: traceCapturePath,
    loopArcPoints: loopArcPoints,
    __setVisitGenForTest: setVisitGenForTest,
    boardToString: boardToString
  };

  global.SurakartaRules = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
