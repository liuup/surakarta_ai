'use strict';
/*
 * 对局诊断脚本：统计每一手棋之后对方立刻获得了多少吃子机会，
 * 用来判断某一方是战术上被击溃，还是仅仅在局面争夺中落后。
 *
 * 用法：node tests/diagnose.js <黑方档位|rand> <红方档位|rand> [时间上限毫秒]
 */
const R = require('../js/rules.js');
const AI = require('../js/ai.js');

const blackKey = process.argv[2] || '4';
const redKey = process.argv[3] || '2';
const timeCap = Number(process.argv[4] || 800);

function configFor(key) {
  if (key === 'rand') return null;
  const level = AI.LEVELS.find(l => l.key === Number(key));
  if (!level) throw new Error('档位必须是 1 到 4，或 rand');
  return { depth: level.depth, timeMs: Math.min(level.timeMs, timeCap), nodeChunk: 100000 };
}

const configs = { 1: configFor(blackKey), 2: configFor(redKey) };

function chooseMove(board, side) {
  const config = configs[side];
  const moves = R.generateMoves(board, side, false);
  if (moves.length === 0) return -1;
  if (!config) return moves[Math.floor(Math.random() * moves.length)];
  const plan = AI.beginSearch(board, side, config);
  for (;;) {
    if (plan.step().done) break;
  }
  return plan.pickWithNoise({ blunder: 0 });
}

function capturesAvailable(board, side) {
  return R.generateMoves(board, side, true).length;
}

const board = R.initialBoard();
let side = R.BLACK;
let plies = 0;
const stats = {
  1: { granted: 0, taken: 0, moves: 0 },
  2: { granted: 0, taken: 0, moves: 0 }
};

while (plies < 300) {
  const counts = R.countPieces(board);
  if (counts.black === 0 || counts.red === 0) break;
  const granted = capturesAvailable(board, side);      // 对方上一手留下的吃子机会
  if (R.generateMoves(board, side, false).length === 0) break;
  const move = chooseMove(board, side);
  if (move < 0) break;
  const captured = board[R.moveTo(move)] !== 0;
  stats[side].moves++;
  if (granted > 0) stats[side].granted++;
  if (captured) stats[side].taken++;
  R.applyMove(board, move);
  side = 3 - side;
  plies++;
}

const counts = R.countPieces(board);
console.log(`黑方 ${blackKey} vs 红方 ${redKey}`);
console.log(`  最终子力：黑 ${counts.black}，红 ${counts.red}；手数 ${plies}`);
for (const s of [1, 2]) {
  const name = s === 1 ? '黑方' : '红方';
  const st = stats[s];
  console.log(`  ${name}：行棋 ${st.moves} 手，其中 ${st.granted} 手有吃子机会，实际吃子 ${st.taken} 次`);
}
