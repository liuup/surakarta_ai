'use strict';
/* 苏拉卡尔塔 AI 测试（node tests/ai.test.js） */

const R = require('../js/rules.js');
const AI = require('../js/ai.js');
const assert = require('assert');

const idx = R.idx, BLACK = R.BLACK, RED = R.RED;
let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('  通过：' + name);
}
function emptyBoard() { return new Int8Array(R.CELLS); }

/** 把一次搜索推进到结束 */
function runSearch(board, side, level) {
  const plan = AI.beginSearch(board, side, level);
  let guard = 0;
  for (;;) {
    const state = plan.step();
    if (state.done) return { plan, state };
    if (++guard > 100000) throw new Error('搜索未能结束');
  }
}

function legalSet(board, side) {
  return new Set(R.generateMoves(board, side, false));
}

console.log('AI 测试');

check('四档难度都能给出合法着法', () => {
  const board = R.initialBoard();
  for (const level of AI.LEVELS) {
    const legal = legalSet(board, BLACK);
    const t0 = Date.now();
    const { state } = runSearch(board, BLACK, level);
    const elapsed = Date.now() - t0;
    assert.ok(legal.has(state.move), `第 ${level.key} 档返回了非法着法`);
    assert.ok(elapsed <= level.timeMs + 1500, `第 ${level.key} 档超时：${elapsed}ms`);
    assert.ok(state.depth >= 1, `第 ${level.key} 档未完成任何深度`);
    console.log(`      第 ${level.key} 档（${level.name}）：深度 ${state.depth}，` +
      `节点 ${state.nodes}，用时 ${elapsed}ms，评分 ${state.score}`);
  }
});

check('节点预算极小时也能正确分块推进', () => {
  const board = R.initialBoard();
  AI.clearTable();                        // 清空置换表，确保这次搜索需要真正展开搜索树
  const plan = AI.beginSearch(board, BLACK, { depth: 6, timeMs: 30000, nodeChunk: 2048 });
  let steps = 0;
  let state;
  for (;;) {
    state = plan.step();
    steps++;
    if (state.done) break;
    assert.ok(steps < 100000);
  }
  assert.ok(steps > 1, '小预算下应当需要多次推进');
  assert.ok(state.nodes > 2000, '确实搜到了较深层次');
  assert.ok(legalSet(board, BLACK).has(state.move), '着法必须合法');
});

check('能够吃掉可以直接吃到的棋子', () => {
  const board = emptyBoard();
  board[idx(1, 1)] = BLACK;
  board[idx(2, 1)] = RED;
  board[idx(5, 0)] = RED;
  board[idx(0, 4)] = RED;
  board[idx(3, 3)] = BLACK;
  board[idx(4, 4)] = BLACK;
  const legal = legalSet(board, BLACK);
  for (const level of AI.LEVELS) {
    const { state } = runSearch(board, BLACK, level);
    assert.ok(legal.has(state.move), '着法必须合法');
    assert.strictEqual(R.moveFrom(state.move), idx(1, 1), '应当用 (1,1) 的棋子吃子');
    assert.strictEqual(R.moveTo(state.move), idx(2, 1));
  }
});

check('能吃光对方最后一子时立即结束战斗', () => {
  const board = emptyBoard();
  board[idx(1, 1)] = BLACK;
  board[idx(3, 3)] = BLACK;
  board[idx(2, 1)] = RED;   // 红方最后一枚棋子
  const { state } = runSearch(board, BLACK, AI.LEVELS[2]);
  assert.strictEqual(R.moveTo(state.move), idx(2, 1));
  assert.ok(state.score >= AI.WIN - 1000, '评分应当识别出必胜');
});

check('己方无子可动时返回 -1', () => {
  const board = emptyBoard();
  board[idx(0, 0)] = BLACK;   // 角上的孤子，周围空点都被堵住
  board[idx(0, 1)] = RED;
  board[idx(1, 0)] = RED;
  board[idx(1, 1)] = RED;
  const moves = R.generateMoves(board, BLACK, false);
  assert.strictEqual(moves.length, 0, '测试局面应当无子可动');
  const { state } = runSearch(board, BLACK, AI.LEVELS[1]);
  assert.strictEqual(state.move, -1);
});

check('自我对局中每一步都合法且对局能够推进', () => {
  const level = { key: 5, name: '快速', depth: 3, timeMs: 300 };
  let board = R.initialBoard();
  let side = BLACK;
  let captures = 0;
  let plies = 0;
  for (; plies < 60; plies++) {
    const legal = legalSet(board, side);
    if (legal.size === 0) break;
    const { state } = runSearch(board, side, level);
    assert.ok(legal.has(state.move), `第 ${plies} 手非法着法`);
    const captured = R.applyMove(board, state.move);
    if (captured) captures++;
    const counts = R.countPieces(board);
    if (counts.black === 0 || counts.red === 0) { plies++; break; }
    side = 3 - side;
  }
  assert.ok(plies >= 20, '对局应当能推进足够多手');
  console.log(`      自我对局推进 ${plies} 手，出现吃子 ${captures} 次`);
});

check('走回已经出现过的局面至多只算和棋', () => {
  const board = R.initialBoard();
  // 该测试要求深度 1 的分值只由评估函数给出，因此局面里不能有吃子
  assert.strictEqual(R.generateMoves(board, BLACK, true).length, 0, '测试局面不应有吃子');
  assert.strictEqual(R.generateMoves(board, RED, true).length, 0, '测试局面不应有吃子');
  const level = { depth: 1, timeMs: 30000, exactRootScores: true, nodeChunk: 100000 };

  AI.clearTable();
  const plain = runSearch(board, BLACK, level);
  const before = plain.plan.rootScores().find(s => s.move === plain.state.move);
  const best = plain.state.move;
  assert.ok(before && before.score > 0, '测试局面下最优着法应当是正分（实际 ' + (before && before.score) + '）');

  // 把「走了这一步之后形成的局面」放进历史，它就成了重复局面
  const after = R.cloneBoard(board);
  R.applyMove(after, best);
  AI.clearTable();
  const repeated = runSearch(board, BLACK, Object.assign({
    history: [AI.hashOf(board, BLACK), AI.hashOf(after, RED)]
  }, level));
  const after2 = repeated.plan.rootScores().find(s => s.move === best);

  assert.ok(after2, '第二次搜索也应当包含该着法');
  assert.strictEqual(after2.score, 0,
    '占优时走回旧局面应当被折算成和棋（实际 ' + after2.score + '）');
  assert.notStrictEqual(repeated.state.move, best, '存在其他着法时不应走回旧局面');
  assert.ok(legalSet(board, BLACK).has(repeated.state.move), '返回的着法必须合法');
});

check('落后时走回旧局面不会带来额外好处', () => {
  // 让黑方少两子：此时任何着法的分值都是负的，折算成和棋的规则不应当
  // 让 AI 产生「靠重复来拖延」的动机，因此它仍然会选自己认为最好的着法。
  const board = emptyBoard();
  board[idx(1, 1)] = BLACK;
  board[idx(3, 3)] = BLACK;
  board[idx(1, 4)] = RED;
  board[idx(4, 1)] = RED;
  board[idx(4, 4)] = RED;
  board[idx(5, 5)] = RED;
  const level = { depth: 2, timeMs: 30000, exactRootScores: true, nodeChunk: 100000 };

  AI.clearTable();
  const plain = runSearch(board, BLACK, level);
  const best = plain.state.move;
  const after = R.cloneBoard(board);
  R.applyMove(after, best);
  AI.clearTable();
  const repeated = runSearch(board, BLACK, Object.assign({
    history: [AI.hashOf(board, BLACK), AI.hashOf(after, RED)]
  }, level));
  const a = plain.plan.rootScores().find(s => s.move === best);
  const b = repeated.plan.rootScores().find(s => s.move === best);
  assert.ok(a && b, '两次搜索都应当包含该着法');
  assert.ok(a.score < 0, '该局面下黑方应当处于劣势（实际 ' + a.score + '）');
  assert.strictEqual(b.score, a.score, '负分着法不应因为重复而改变分值');
});

check('还没搜完就来取着法，拿到的也必须是一步合法棋', () => {
  const board = R.initialBoard();
  const level = { key: 9, name: '测试', depth: 6, timeMs: 30000, blunder: 0 };
  const legal = legalSet(board, BLACK);
  const plan = AI.beginSearch(board, BLACK, level);
  // 一个深度都还没完成
  assert.ok(legal.has(plan.pickWithNoise(level)), '未搜完时返回的着法必须合法');
  assert.ok(legal.has(plan.info().move), 'info() 里的着法也必须合法');
  let state;
  for (;;) { state = plan.step(); if (state.done) break; }
  assert.ok(legal.has(state.move), '搜完后返回的着法必须合法');
});

check('对局历史不会通过置换表污染后续搜索', () => {
  const board = R.initialBoard();
  const level = { depth: 1, timeMs: 30000, exactRootScores: true, nodeChunk: 100000 };

  AI.clearTable();
  const plain = runSearch(board, BLACK, level);
  const best = plain.state.move;
  const trueScore = plain.plan.rootScores().find(s => s.move === best).score;

  // 不清理置换表，接着带上「这一步之后形成的局面」再搜一次：
  // 折算必须仍然生效（也就是说，表里缓存的分值没有被历史影响）。
  const after = R.cloneBoard(board);
  R.applyMove(after, best);
  const repeated = runSearch(board, BLACK, Object.assign({
    history: [AI.hashOf(board, BLACK), AI.hashOf(after, RED)]
  }, level));
  assert.strictEqual(repeated.plan.rootScores().find(s => s.move === best).score, 0,
    '置换表里已经有缓存时，重复折算仍应生效');

  // 再用空历史搜一次，分值必须回到真实值
  const again = runSearch(board, BLACK, level);
  assert.strictEqual(again.plan.rootScores().find(s => s.move === best).score, trueScore,
    '去掉历史后分值应当回到真实值');
});

check('搜索速度基准', () => {
  const board = R.initialBoard();
  const plan = AI.beginSearch(board, BLACK, { depth: 8, timeMs: 3000, nodeChunk: 100000 });
  let state;
  for (;;) {
    state = plan.step();
    if (state.done) break;
  }
  const nps = Math.round(state.nodes / Math.max(state.elapsedMs, 1) * 1000);
  console.log(`      3 秒内到达深度 ${state.depth}，共 ${state.nodes} 节点，约 ${nps} 节点/秒`);
  assert.ok(nps > 20000, '搜索速度过低：' + nps);
});

console.log(`全部 ${passed} 项 AI 测试通过。`);
