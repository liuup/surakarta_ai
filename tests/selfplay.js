'use strict';
/*
 * 自我对局脚本：比较两档难度的棋力
 * 用法：node tests/selfplay.js <黑方档位 1-4> <红方档位 1-4> [每步时间上限毫秒]
 */
const R = require('../js/rules.js');
const AI = require('../js/ai.js');

const blackKey = process.argv[2] || '4';
const redKey = process.argv[3] || '1';
const timeCap = Number(process.argv[4] || 600);

/* 保留每一档自己的随机让子（低难度的「偶尔漏算」就靠它），否则各档看起来会没有差别 */
function levelByKey(key) {
  if (key === 'rand') return { depth: 0, timeMs: 0, nodeChunk: 100000, key: 'rand', name: '随机走子' };
  const level = AI.LEVELS.find(l => l.key === Number(key));
  if (!level) throw new Error('档位必须是 1 到 4，或 rand');
  return Object.assign({}, level, { timeMs: Math.min(level.timeMs, timeCap), nodeChunk: 100000 });
}

const configs = { 1: levelByKey(blackKey), 2: levelByKey(redKey) };

function chooseMove(board, side) {
  const config = configs[side];
  if (config.key === 'rand') {
    const moves = R.generateMoves(board, side, false);
    if (moves.length === 0) return { move: -1, state: {} };
    return { move: moves[Math.floor(Math.random() * moves.length)], state: {} };
  }
  const plan = AI.beginSearch(board, side, config);
  let state;
  for (;;) {
    state = plan.step();
    if (state.done) break;
  }
  if (state.move < 0) return { move: -1, state };
  return { move: plan.pickWithNoise(config), state };
}

const board = R.initialBoard();
let side = R.BLACK;
let plies = 0;
const t0 = Date.now();
const depths = { 1: [], 2: [] };

while (plies < 400) {
  const counts = R.countPieces(board);
  if (counts.black === 0 || counts.red === 0) break;
  if (R.generateMoves(board, side, false).length === 0) break;
  const { move, state } = chooseMove(board, side);
  if (move < 0) break;
  if (state.depth) depths[side].push(state.depth);
  R.applyMove(board, move);
  side = 3 - side;
  plies++;
}

const counts = R.countPieces(board);
const result = counts.black === 0 ? '红方胜' : (counts.red === 0 ? '黑方胜' : '未分胜负');
const avg = list => list.length ? (list.reduce((a, b) => a + b, 0) / list.length).toFixed(1) : '—';
console.log(`黑方 ${configs[1].name} vs 红方 ${configs[2].name}`);
console.log(`  结果：${result}（黑 ${counts.black} 子，红 ${counts.red} 子）`);
console.log(`  手数：${plies}，用时 ${((Date.now() - t0) / 1000).toFixed(1)} 秒`);
console.log(`  平均完成深度：黑 ${avg(depths[1])}，红 ${avg(depths[2])}`);
console.log(R.boardToString(board));
