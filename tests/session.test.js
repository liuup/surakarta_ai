'use strict';
/*
 * 对局会话测试（node tests/session.test.js）
 *
 * js/session.js 是网页、终端界面与后端服务共用的那一份对局逻辑，
 * 这里不经过任何界面直接测它：走子、悔棋、终局、AI 调度、状态序列化。
 */
const assert = require('assert');
const R = require('../js/rules.js');
const S = require('../js/session.js');
const AI = require('../js/ai.js');

const BLACK = R.BLACK, RED = R.RED;
let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('  通过：' + name);
}

/** 把 AI 搜索跑到底 */
function runAI(session, limit = 200000) {
  session.startAI({ chunkMs: 0 });
  let steps = 0;
  for (;;) {
    const result = session.stepAI();
    if (result.done) return result;
    if (++steps > limit) throw new Error('AI 搜索没有结束');
  }
}

function firstLegal(board, side) {
  return R.generateMoves(board, side, false)[0];
}

console.log('对局会话测试');

check('开局状态正确且可以序列化', () => {
  const session = S.createSession();
  const state = session.state();
  assert.strictEqual(state.counts.black, 12);
  assert.strictEqual(state.counts.red, 12);
  assert.strictEqual(state.side, BLACK);
  assert.strictEqual(state.humanSide, BLACK);
  assert.strictEqual(state.status, 'playing');
  assert.strictEqual(state.moves.length, 0);
  assert.strictEqual(state.legal.length, 16);
  assert.strictEqual(state.board.length, R.CELLS);
  assert.strictEqual(state.levels.length, AI.LEVELS.length);
  // 必须能原样 JSON 往返（后端就是这么传给前端的）
  const round = JSON.parse(JSON.stringify(state));
  assert.deepStrictEqual(round, state);
});

check('走子、非法着法、以及轮次交换', () => {
  const session = S.createSession();
  const move = firstLegal(session.state().board, BLACK);
  assert.deepStrictEqual(session.playMove(move), { ok: true });
  const after = session.state();
  assert.strictEqual(after.side, RED, '走完轮到红方');
  assert.strictEqual(after.moves.length, 1);
  assert.strictEqual(after.lastMove, move);
  assert.deepStrictEqual(after.moves[0], { side: BLACK, from: move >> 6, to: move & 63, capture: false },
    '着法记录应当是结构化数据：' + JSON.stringify(after.moves[0]));

  const bad = session.playMove((R.idx(0, 0) << 6) | R.idx(5, 5));
  assert.strictEqual(bad.ok, false, '非法着法应当被拒绝');
  assert.strictEqual(bad.error.code, 'err.illegalMove', '错误应当是错误码：' + JSON.stringify(bad.error));
  assert.strictEqual(bad.error.params.from, 'a1');
  assert.strictEqual(bad.error.params.to, 'f6');
  assert.strictEqual(session.state().moves.length, 1, '被拒绝的着法不应当留下痕迹');
});

check('吃子会记录绕行路线，供界面绘制', () => {
  const session = S.createSession();
  // 摆一个黑方可以绕左上角环吃掉红子的局面
  const board = new Int8Array(R.CELLS);
  board[R.idx(1, 1)] = BLACK;
  board[R.idx(2, 1)] = RED;
  session.newGame();
  // 直接用规则引擎找出那一步吃子，再通过会话执行
  const capture = (R.idx(1, 1) << 6) | R.idx(2, 1);
  const legal = R.movesFrom(board, BLACK, R.idx(1, 1)).filter(m => m.move === capture);
  assert.strictEqual(legal.length, 1, '应当存在这一步吃子');
  assert.strictEqual(legal[0].capture, true);
  assert.ok(R.traceCapturePath(board, BLACK, R.idx(1, 1), legal[0].dir).poly.length > 2,
    '吃子路径应当包含绕环的折线点');
});

check('movesFrom 给出落脚点与绕行预览', () => {
  const session = S.createSession();
  const hints = session.movesFrom(R.idx(1, 1));
  assert.ok(hints.length > 0, '开局 (1,1) 应当有可走点');
  for (const hint of hints) {
    assert.strictEqual(hint.from, R.idx(1, 1));
    assert.ok(hint.to >= 0 && hint.to < R.CELLS);
    if (hint.capture) assert.ok(hint.path && hint.path.length > 2, '吃子提示应当带绕行路线');
    else assert.strictEqual(hint.path, null, '普通走子没有绕行路线');
  }
  assert.deepStrictEqual(session.movesFrom(R.idx(3, 3)), [], '空点没有可走着的着法');
});

check('AI 能替当前一方走出合法着法', () => {
  const session = S.createSession();
  session.setLevel(0);
  session.playMove(firstLegal(session.state().board, BLACK));
  assert.strictEqual(session.needsAI(), true, '人类执黑走完后轮到 AI');
  assert.strictEqual(session.isThinking(), false);
  const result = runAI(session);
  assert.strictEqual(result.ok, true);
  const state = session.state();
  assert.strictEqual(state.moves.length, 2);
  assert.strictEqual(state.side, BLACK, 'AI 走完应当回到人类');
  assert.strictEqual(state.thinking, false);
  assert.ok(typeof state.lastScore === 'number', '应当记录 AI 的评分');
});

check('悔棋一次撤回双方各一步', () => {
  const session = S.createSession();
  session.setLevel(0);
  session.playMove(firstLegal(session.state().board, BLACK));
  runAI(session);
  assert.strictEqual(session.state().moves.length, 2);

  assert.deepStrictEqual(session.undo(), { ok: true });
  const state = session.state();
  assert.strictEqual(state.moves.length, 0, '双方各一步都应当撤回');
  assert.strictEqual(state.side, BLACK);
  assert.strictEqual(state.counts.black, 12);
  assert.strictEqual(state.counts.red, 12);
  assert.strictEqual(state.lastMove, null);
  assert.strictEqual(session.undo().ok, false, '没有可撤销的着法时应当报错');
});

check('人类执红时由 AI 先行', () => {
  const session = S.createSession();
  session.setLevel(0);
  session.setHumanSide(RED);
  const state = session.state();
  assert.strictEqual(state.humanSide, RED);
  assert.strictEqual(state.side, BLACK, '新对局仍然黑先行');
  assert.strictEqual(state.moves.length, 0);
  assert.strictEqual(session.needsAI(), true, 'AI 执黑，应当轮到 AI');
  runAI(session);
  assert.strictEqual(session.state().moves.length, 1);
  assert.strictEqual(session.needsAI(), false, 'AI 走完轮到人类');
});

check('协商终局按剩余子力判定', () => {
  const session = S.createSession();
  assert.deepStrictEqual(session.agreeEnd(), { ok: true });
  const state = session.state();
  assert.strictEqual(state.status, 'over');
  assert.strictEqual(state.result.kind, 'agreed');
  assert.strictEqual(state.result.judge.winner, 0, '开局子力相等应当是和棋');
  assert.strictEqual(state.result.judge.black, 12);
  assert.strictEqual(session.playMove(firstLegal(R.initialBoard(), BLACK)).ok, false,
    '终局后不应还能走子');
});

check('吃光对方最后一子立即结束', () => {
  const session = S.createSession();
  const board = new Int8Array(R.CELLS);
  board[R.idx(1, 1)] = BLACK;
  board[R.idx(3, 3)] = BLACK;
  board[R.idx(2, 1)] = RED;          // 红方最后一枚棋子
  assert.deepStrictEqual(session.loadPosition(board, BLACK), { ok: true });

  const before = session.state();
  assert.strictEqual(before.status, 'playing');
  assert.strictEqual(before.counts.red, 1);
  const capture = (R.idx(1, 1) << 6) | R.idx(2, 1);
  assert.ok(before.legal.indexOf(capture) >= 0, '应当可以吃掉最后一枚红子');

  assert.deepStrictEqual(session.playMove(capture), { ok: true });
  const after = session.state();
  assert.strictEqual(after.counts.red, 0);
  assert.strictEqual(after.status, 'over', '吃光对方后应当立即结束');
  assert.strictEqual(after.result.kind, 'wipeout');
  assert.strictEqual(after.result.winner, BLACK, '获胜方应当是黑方');
  assert.strictEqual(after.thinking, false);
  assert.strictEqual(session.needsAI(), false);
});

check('轮到的一方无子可动时按协商规则结束', () => {
  const session = S.createSession();
  const board = new Int8Array(R.CELLS);
  // 角上的黑子四个方向都被红子堵死，且角点没有环，因此一步也走不了
  board[R.idx(0, 0)] = BLACK;
  board[R.idx(0, 1)] = RED;
  board[R.idx(1, 0)] = RED;
  board[R.idx(1, 1)] = RED;
  board[R.idx(4, 4)] = RED;
  session.loadPosition(board, BLACK);

  const state = session.state();
  assert.strictEqual(state.legal.length, 0, '该局面下黑方应当无子可动');
  assert.strictEqual(state.status, 'over');
  assert.strictEqual(state.result.kind, 'stalemate');
  assert.strictEqual(state.result.side, BLACK, '无子可动的是黑方');
  assert.strictEqual(state.result.judge.winner, RED, '子力多的一方应当是红方');
});

check('载入局面后可以正常继续对局', () => {
  const session = S.createSession();
  session.setLevel(0);
  const board = new Int8Array(R.CELLS);
  // 黑方三子、红方一子：任何一方一着都吃不完对方，对局必定能继续
  board[R.idx(1, 1)] = BLACK;
  board[R.idx(1, 4)] = BLACK;
  board[R.idx(4, 1)] = BLACK;
  board[R.idx(4, 4)] = RED;
  assert.deepStrictEqual(session.loadPosition(board, BLACK), { ok: true });
  assert.strictEqual(session.state().moves.length, 0, '载入局面应当清空着法记录');

  const start = session.state();
  const quiet = start.legal.find(m => start.board[R.moveTo(m)] === R.EMPTY);
  assert.ok(quiet !== undefined, '应当存在非吃子的着法');
  session.playMove(quiet);
  assert.strictEqual(session.needsAI(), true, '人类走完后应当轮到 AI');
  runAI(session);

  const after = session.state();
  assert.strictEqual(after.moves.length, 2);
  assert.strictEqual(after.status, 'playing', '双方都还有子，对局应当继续');
  assert.strictEqual(session.undo().ok, true);
  assert.strictEqual(session.state().moves.length, 0);
  assert.strictEqual(session.state().counts.black, 3, '悔棋应当把子力也复原');
});

check('载入非法棋盘会被拒绝', () => {
  const session = S.createSession();
  assert.strictEqual(session.loadPosition(new Int8Array(10), BLACK).ok, false);
  assert.strictEqual(session.loadPosition(null, BLACK).ok, false);
});

check('难度与执子方可以切换，且状态里带着档位信息', () => {
  const session = S.createSession();
  for (let i = 0; i < AI.LEVELS.length; i++) {
    session.setLevel(i);
    const state = session.state();
    assert.strictEqual(state.level, i);
    assert.strictEqual(state.levelKey, AI.LEVELS[i].key);
    assert.strictEqual(state.levelDepth, AI.LEVELS[i].depth);
    assert.strictEqual(state.levels[i].key, AI.LEVELS[i].key);
    assert.strictEqual(state.levels[i].name, undefined, '档位名应当由界面按语言查表，状态里不带');
  }
  session.setLevel(99);
  assert.strictEqual(session.state().level, AI.LEVELS.length - 1, '越界应当被夹到最后一档');
  session.setLevel(-5);
  assert.strictEqual(session.state().level, 0, '越界应当被夹到第一档');

  session.setLevel(0);
  session.playMove(firstLegal(session.state().board, BLACK));
  session.setHumanSide(RED);          // 换边会重开一局
  const state = session.state();
  assert.strictEqual(state.moves.length, 0, '换边应当重开新对局');
  assert.strictEqual(state.humanSide, RED);
  assert.strictEqual(state.level, 0, '换边不应当重置难度');
});

check('新开一局与载入局面都会清掉上一局的搜索统计', () => {
  const session = S.createSession();
  session.setLevel(0);
  session.playMove(firstLegal(session.state().board, BLACK));
  runAI(session);
  assert.ok(typeof session.state().lastScore === 'number', 'AI 走完应当有评分');
  assert.ok(session.state().lastSearch, 'AI 走完应当有搜索统计');

  session.newGame();
  assert.strictEqual(session.state().lastScore, null, '新开一局不应残留上一局的评分');
  assert.strictEqual(session.state().lastSearch, null, '新开一局不应残留上一局的搜索统计');

  session.playMove(firstLegal(session.state().board, BLACK));
  runAI(session);
  const board = new Int8Array(R.CELLS);
  board[R.idx(1, 1)] = BLACK;
  board[R.idx(4, 4)] = RED;
  session.loadPosition(board, BLACK);
  assert.strictEqual(session.state().lastScore, null, '载入局面不应残留评分');
  assert.strictEqual(session.state().lastSearch, null, '载入局面不应残留搜索统计');
});

check('revision 与 position 的变化时机正确', () => {
  const session = S.createSession();
  const start = session.state();
  session.setLevel(1);
  const afterLevel = session.state();
  assert.ok(afterLevel.revision > start.revision, '改难度应当让 revision 变化');
  assert.strictEqual(afterLevel.position, start.position, '改难度不应当让 position 变化');

  session.playMove(firstLegal(session.state().board, BLACK));
  const afterMove = session.state();
  assert.ok(afterMove.position > afterLevel.position, '走子应当让 position 变化');
});

console.log(`全部 ${passed} 项会话测试通过。`);
