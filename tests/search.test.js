'use strict';
/*
 * 搜索引擎正确性测试：把 AI 的总分与一个不加任何剪枝、
 * 不使用置换表的朴素极小极大搜索逐一对比。
 * 两者使用同一套规则与同一个评估函数，因此同一深度下根节点分值必须完全相同。
 *
 * 用法：node tests/search.test.js
 */
const R = require('../js/rules.js');
const AI = require('../js/ai.js');
const assert = require('assert');

const BLACK = R.BLACK, RED = R.RED;
const WIN = AI.WIN;
const INF = 1 << 28;
const QDEPTH = 2;              // 两边一致地关闭吃子延伸的影响：只延伸 2 层
const MAX_PLY = 30;

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('  通过：' + name);
}

function cloneBoard(board) { return Int8Array.from(board); }

function countOf(board, side) {
  const counts = R.countPieces(board);
  return side === BLACK ? counts.black : counts.red;
}

/** 朴素吃子静态搜索：完全展开吃子着法 */
function bruteQuiesce(board, side, ply, depthLeft) {
  const standPat = AI.evaluateBoard(board, side);
  let best = standPat;
  if (depthLeft <= 0 || ply >= MAX_PLY) return best;
  const opp = 3 - side;
  for (const move of R.generateMoves(board, side, true)) {
    const next = cloneBoard(board);
    R.applyMove(next, move);
    const score = countOf(next, opp) === 0
      ? WIN - ply
      : -bruteQuiesce(next, opp, ply + 1, depthLeft - 1);
    if (score > best) best = score;
  }
  return best;
}

/** 朴素极小极大（负极大值形式），全窗口、无剪枝、无置换表 */
function bruteNegamax(board, side, depth, ply) {
  if (countOf(board, side) === 0) return -(WIN - ply);
  if (ply >= MAX_PLY) return AI.evaluateBoard(board, side);
  const moves = R.generateMoves(board, side, false);
  if (moves.length === 0) {
    const my = countOf(board, side), other = countOf(board, 3 - side);
    if (my > other) return WIN - ply - 1;
    if (my < other) return -(WIN - ply - 1);
    return 0;
  }
  if (depth <= 0) return bruteQuiesce(board, side, ply, QDEPTH);
  const opp = 3 - side;
  let best = -INF;
  for (const move of moves) {
    const next = cloneBoard(board);
    R.applyMove(next, move);
    const score = countOf(next, opp) === 0
      ? WIN - ply
      : -bruteNegamax(next, opp, depth - 1, ply + 1);
    if (score > best) best = score;
  }
  return best;
}

/** 让引擎在指定深度上搜完，返回根节点总分 */
function engineScore(board, side, depth) {
  const plan = AI.beginSearch(board, side, {
    depth: depth,
    timeMs: 600000,
    nodeChunk: 1000000,
    quiesceDepth: QDEPTH
  });
  let state;
  for (;;) {
    state = plan.step();
    if (state.done) break;
  }
  assert.strictEqual(state.depth, depth, `应当完成深度 ${depth}`);
  return state.score;
}

/** 生成若干随机中局局面 */
function randomPositions(count, seed) {
  let s = seed;
  const rnd = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  const positions = [];
  for (let i = 0; i < count; i++) {
    let board = R.initialBoard();
    const plies = 4 + Math.floor(rnd() * 12);
    let side = BLACK;
    for (let p = 0; p < plies; p++) {
      const moves = R.generateMoves(board, side, false);
      if (moves.length === 0) break;
      const move = moves[Math.floor(rnd() * moves.length)];
      board = cloneBoard(board);
      R.applyMove(board, move);
      side = 3 - side;
    }
    positions.push({ board: board, side: side });
  }
  return positions;
}

console.log('搜索引擎正确性测试');

check('初始局面各深度与朴素极小极大结果一致', () => {
  const board = R.initialBoard();
  for (const depth of [1, 2, 3]) {
    const engine = engineScore(board, BLACK, depth);
    const brute = bruteNegamax(board, BLACK, depth, 0);
    assert.strictEqual(engine, brute, `深度 ${depth} 评分不一致：引擎 ${engine}，朴素 ${brute}`);
  }
});

check('随机中局局面在深度 1 与 2 上结果一致', () => {
  const positions = randomPositions(12, 20240917);
  for (let i = 0; i < positions.length; i++) {
    const { board, side } = positions[i];
    for (const depth of [1, 2]) {
      const engine = engineScore(board, side, depth);
      const brute = bruteNegamax(board, side, depth, 0);
      assert.strictEqual(engine, brute,
        `第 ${i} 个局面深度 ${depth} 不一致：引擎 ${engine}，朴素 ${brute}\n` + R.boardToString(board));
    }
  }
});

check('吃子局面在深度 3 上结果一致', () => {
  const positions = randomPositions(3, 777).map(p => p.board);
  // 挑选存在吃子机会的局面
  let tested = 0;
  for (const board of positions) {
    const caps = R.generateMoves(board, BLACK, true);
    const capsRed = R.generateMoves(board, RED, true);
    if (caps.length === 0 && capsRed.length === 0) continue;
    const engine = engineScore(board, BLACK, 3);
    const brute = bruteNegamax(board, BLACK, 3, 0);
    assert.strictEqual(engine, brute,
      `评分不一致：引擎 ${engine}，朴素 ${brute}\n` + R.boardToString(board));
    tested++;
  }
  assert.ok(tested > 0, '应当至少测到一个含吃子的局面');
});

check('置换表不会改变搜索结果，且黑白对称变换下结果一致', () => {
  const board = R.initialBoard();
  AI.clearTable();
  const first = engineScore(board, BLACK, 3);
  // 再搜一次，此时置换表已经填满上一次的结果
  assert.strictEqual(first, engineScore(board, BLACK, 3));
  // 开局棋盘在“旋转 180 度并交换双方颜色”下仍是开局，因此黑先与红先的分值应当相同
  assert.strictEqual(first, engineScore(board, RED, 3));

  // 任意局面：旋转 180 度、交换颜色并换由另一方走棋，分值应当不变
  for (const { board: b, side } of randomPositions(4, 4242)) {
    const mirrored = new Int8Array(R.CELLS);
    for (let cell = 0; cell < R.CELLS; cell++) {
      const piece = b[cell];
      mirrored[R.CELLS - 1 - cell] = piece === 0 ? 0 : 3 - piece;
    }
    assert.strictEqual(
      engineScore(b, side, 2),
      engineScore(mirrored, 3 - side, 2),
      '黑白对称变换不成立\n' + R.boardToString(b)
    );
  }
});

console.log(`全部 ${passed} 项搜索正确性测试通过。`);
