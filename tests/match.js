'use strict';
/*
 * 对抗赛脚本：两个档位各执黑各执白若干局，统计胜负与子力差。
 * 用法：node tests/match.js <档位A> <档位B> [每方每色局数] [时间上限毫秒]
 */
const R = require('../js/rules.js');
const AI = require('../js/ai.js');

const keyA = process.argv[2] || '4';
const keyB = process.argv[3] || '2';
const gamesPerColor = Number(process.argv[4] || 2);
const timeCap = Number(process.argv[5] || 800);

/* 保留每一档自己的随机让子与是否全窗口搜根节点：
 * 低难度档的「偶尔漏算」正是靠 blunder 实现的，把它关掉会让各档之间看起来没有差别。 */
function configFor(key) {
  if (key === 'rand') return null;
  const level = AI.LEVELS.find(l => l.key === Number(key));
  if (!level) throw new Error('档位必须是 1 到 4，或 rand');
  return Object.assign({}, level, { timeMs: Math.min(level.timeMs, timeCap), nodeChunk: 200000 });
}

function chooseMove(board, side, configs) {
  const config = configs[side];
  const moves = R.generateMoves(board, side, false);
  if (moves.length === 0) return -1;
  if (!config) return moves[Math.floor(Math.random() * moves.length)];
  const plan = AI.beginSearch(board, side, config);
  for (;;) {
    if (plan.step().done) break;
  }
  return plan.pickWithNoise(config);
}

function playGame(configBlack, configRed) {
  const configs = { 1: configBlack, 2: configRed };
  let board = R.initialBoard();
  let side = R.BLACK;
  let plies = 0;
  while (plies < 300) {
    const counts = R.countPieces(board);
    if (counts.black === 0 || counts.red === 0) break;
    if (R.generateMoves(board, side, false).length === 0) break;
    const move = chooseMove(board, side, configs);
    if (move < 0) break;
    R.applyMove(board, move);
    side = 3 - side;
    plies++;
  }
  const counts = R.countPieces(board);
  return { black: counts.black, red: counts.red, plies: plies };
}

const summary = {
  A: { wins: 0, losses: 0, draws: 0, material: 0, asBlack: 0, asRed: 0 },
  B: { wins: 0, losses: 0, draws: 0, material: 0, asBlack: 0, asRed: 0 }
};

for (let g = 0; g < gamesPerColor; g++) {
  for (const aIsBlack of [true, false]) {
    const configA = configFor(keyA);
    const configB = configFor(keyB);
    const result = aIsBlack ? playGame(configA, configB) : playGame(configB, configA);
    const aCount = aIsBlack ? result.black : result.red;
    const bCount = aIsBlack ? result.red : result.black;
    summary.A.material += aCount - bCount;
    summary.B.material += bCount - aCount;
    if (aIsBlack) summary.A.asBlack += aCount - bCount;
    else summary.A.asRed += aCount - bCount;
    const decided = aCount === 0 || bCount === 0;
    if (!decided) { summary.A.draws++; summary.B.draws++; }
    else if (aCount === 0) { summary.B.wins++; summary.A.losses++; }
    else { summary.A.wins++; summary.B.losses++; }
    console.log(`  A(档位 ${keyA})${aIsBlack ? '执黑' : '执白'} vs B(档位 ${keyB})：` +
      `黑 ${result.black} - 红 ${result.red}，${result.plies} 手，` +
      `${decided ? (aCount === 0 ? 'B 胜' : 'A 胜') : '未分胜负'}`);
  }
}

console.log(`\n汇总：A(档位 ${keyA}) 胜 ${summary.A.wins}（净子力 ${summary.A.material}，执黑 ${summary.A.asBlack}，执白 ${summary.A.asRed}），` +
  `B(档位 ${keyB}) 胜 ${summary.B.wins}（净子力 ${summary.B.material}），未分胜负 ${summary.A.draws}`);
