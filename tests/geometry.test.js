'use strict';
/*
 * 角环几何的独立交叉验证（node tests/geometry.test.js）
 *
 * js/rules.js 里的吃子路径是用「查表 + 整数步进」实现的：每个环的两个端点、
 * 以及出环后的行进方向都被预先算好。这种写法快，但如果几何理解有偏差，
 * 表本身也会一起错，测试就发现不了。
 *
 * 所以这里用完全不同的方式再实现一遍：把棋子当成棋盘上的一个点，
 * 用浮点坐标和角度来模拟——沿直线前进，出界后求出那个与出射点相切、
 * 半径为 1 或 2 格、圆心落在角点上的圆，沿圆转 3/4 圈，再从圆周上
 * 切回棋盘，并用速度向量确定新的行进方向。
 *
 * 两套实现只共享「第一枚棋子挡路即终止」「至少绕过一个环才能吃」「起点在
 * 离开后视为空点」这些规则性描述，几何部分完全独立。若两者在大量随机
 * 局面上给出完全一致的吃子结果，就可以确信规则引擎的几何是对的。
 */
const R = require('../js/rules.js');
const assert = require('assert');

const SIZE = 6, CELLS = SIZE * SIZE;
const EMPTY = 0, BLACK = 1, RED = 2;

const DIRS = [
  { dr: 0, dc: 1 }, { dr: 0, dc: -1 }, { dr: 1, dc: 0 }, { dr: -1, dc: 0 }
];

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('  通过：' + name);
}

const near = (a, b) => Math.abs(a - b) < 1e-9;
const isInt = x => Math.abs(x - Math.round(x)) < 1e-9;

/**
 * 模拟棋子从边界上 (r, c) 处沿方向 (dr, dc) 离开棋盘后的绕环过程。
 * 返回 { row, col, dr, dc }（出环后落回棋盘的交叉点与新方向），
 * 该方向上没有环时返回 null。
 */
function loopByAngles(r, c, dr, dc) {
  // 圆心必须是与出射点所在直线垂直的那条边线上的角点。
  // 出射点在边界上：竖直行进时 r 为 0 或 5，圆心是 (r,0) 或 (r,5)；
  // 水平行进时 c 为 0 或 5，圆心是 (0,c) 或 (5,c)。
  const candidates = dr !== 0 ? [[r, 0], [r, SIZE - 1]] : [[0, c], [SIZE - 1, c]];
  let chosen = null;
  for (const [cy, cx] of candidates) {
    const radius = Math.hypot(c - cx, r - cy);       // 用浮点距离，而不是查表得来的半径
    if (radius < 1e-9) continue;                     // 出射点本身就是角点
    if (near(radius, 1) || near(radius, 2)) {
      if (chosen) throw new Error('出射点同时落在两个环上：(' + r + ',' + c + ')');
      chosen = { cx, cy, radius };
    }
  }
  if (!chosen) return null;                          // 这条边线上没有环

  // 沿圆周运动：位置 = 圆心 + 半径·(cosθ, sinθ)（x 为列、y 为行）
  const theta0 = Math.atan2(r - chosen.cy, c - chosen.cx);
  // 速度向量即行进方向；由 v = radius·θ'·(-sinθ, cosθ) 解出转向 θ'
  const omega = (dr * Math.cos(theta0) - dc * Math.sin(theta0)) / chosen.radius;
  if (near(omega, 0)) throw new Error('行进方向与圆不相切');
  const sweep = omega > 0 ? 1.5 * Math.PI : -1.5 * Math.PI;   // 四分之三圈
  const theta1 = theta0 + sweep;

  const x1 = chosen.cx + chosen.radius * Math.cos(theta1);
  const y1 = chosen.cy + chosen.radius * Math.sin(theta1);
  if (!isInt(x1) || !isInt(y1)) throw new Error('出环点不在交叉点上：(' + x1 + ',' + y1 + ')');
  // 出环瞬间的速度方向就是新的行进方向
  const vxRaw = -Math.sin(theta1) * (omega > 0 ? 1 : -1);
  const vyRaw = Math.cos(theta1) * (omega > 0 ? 1 : -1);
  if (!isInt(vxRaw) || !isInt(vyRaw)) {
    throw new Error('出环方向不是轴向：(' + vxRaw + ',' + vyRaw + ')');
  }
  const vx = Math.round(vxRaw), vy = Math.round(vyRaw);   // 抹掉浮点残差
  if (Math.abs(vx) + Math.abs(vy) !== 1) {
    throw new Error('出环方向不是单位轴向：(' + vx + ',' + vy + ')');
  }
  const row = Math.round(y1), col = Math.round(x1);
  if (row < 0 || row >= SIZE || col < 0 || col >= SIZE) {
    throw new Error('出环点落在棋盘外：(' + row + ',' + col + ')');
  }
  return { row, col, dr: Math.round(vy), dc: Math.round(vx) };
}

/** 用浮点几何独立实现的吃子搜索；语义与 rules.walkCapture 相同 */
function captureByAngles(board, side, from, dirIndex) {
  let { dr, dc } = DIRS[dirIndex];
  let r = Math.floor(from / SIZE), c = from % SIZE;
  let loops = 0;
  const seen = new Set();
  for (let guard = 0; guard < 400; guard++) {
    const nr = r + dr, nc = c + dc;
    let cell, key;
    if (nr >= 0 && nr < SIZE && nc >= 0 && nc < SIZE) {
      r = nr; c = nc;
      cell = r * SIZE + c;
    } else {
      const out = loopByAngles(r, c, dr, dc);
      if (!out) return -1;                       // 走到没有环的线头
      r = out.row; c = out.col; dr = out.dr; dc = out.dc;
      cell = r * SIZE + c;
      loops++;
    }
    const occupant = cell === from ? EMPTY : board[cell];   // 起点在棋子离开后即为空点
    if (occupant !== EMPTY) {
      if (occupant !== side && loops > 0) return cell;
      return -1;
    }
    key = cell * 4 + DIRS.findIndex(d => d.dr === dr && d.dc === dc);
    if (seen.has(key)) return -1;                // 同一条线路重复出现，前方再无障碍
    seen.add(key);
  }
  throw new Error('路径未收敛');
}

/** 用浮点几何追踪整条吃子路径（供与 traceCapturePath 对比） */
function traceByAngles(board, side, from, dirIndex) {
  let { dr, dc } = DIRS[dirIndex];
  let r = Math.floor(from / SIZE), c = from % SIZE;
  const cells = [from];
  let loops = 0;
  const seen = new Set();
  for (let guard = 0; guard < 400; guard++) {
    const nr = r + dr, nc = c + dc;
    let cell;
    if (nr >= 0 && nr < SIZE && nc >= 0 && nc < SIZE) {
      r = nr; c = nc; cell = r * SIZE + c;
    } else {
      const out = loopByAngles(r, c, dr, dc);
      if (!out) return { to: -1, cells };
      r = out.row; c = out.col; dr = out.dr; dc = out.dc;
      cell = r * SIZE + c;
      loops++;
    }
    cells.push(cell);
    const occupant = cell === from ? EMPTY : board[cell];
    if (occupant !== EMPTY) {
      if (occupant !== side && loops > 0) return { to: cell, cells };
      return { to: -1, cells };
    }
    const key = cell * 4 + DIRS.findIndex(d => d.dr === dr && d.dc === dc);
    if (seen.has(key)) return { to: -1, cells };
    seen.add(key);
  }
  throw new Error('路径未收敛');
}

function randomBoard(rng) {
  const board = new Int8Array(CELLS);
  for (let i = 0; i < CELLS; i++) {
    const p = rng();
    board[i] = p < 0.55 ? EMPTY : (p < 0.78 ? BLACK : RED);
  }
  return board;
}

function makeRng(seed) {
  let x = seed >>> 0;
  return function () {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    return x / 4294967296;
  };
}

console.log('角环几何交叉验证');

check('浮点几何推出的八个环端点与整数查表完全一致', () => {
  const found = new Map();
  for (let cell = 0; cell < CELLS; cell++) {
    const r = Math.floor(cell / SIZE), c = cell % SIZE;
    for (const { dr, dc } of DIRS) {
      const nr = r + dr, nc = c + dc;
      if (nr >= 0 && nr < SIZE && nc >= 0 && nc < SIZE) continue;   // 只有出界才可能绕环
      const out = loopByAngles(r, c, dr, dc);
      if (!out) {
        assert.strictEqual(R.LOOP_PARTNER[cell], -1,
          `(${r},${c}) 在方向 (${dr},${dc}) 上查表有环而几何计算没有`);
        continue;
      }
      const partner = out.row * SIZE + out.col;
      assert.strictEqual(R.LOOP_PARTNER[cell], partner,
        `(${r},${c}) 的环另一端：查表 ${R.LOOP_PARTNER[cell]}，几何计算 ${partner}`);
      const dirIndex = DIRS.findIndex(d => d.dr === out.dr && d.dc === out.dc);
      assert.strictEqual(R.LOOP_EXIT_DIR[partner], dirIndex,
        `(${r},${c}) 出环后的方向不一致`);
      const key = Math.min(cell, partner) + '-' + Math.max(cell, partner);
      found.set(key, (found.get(key) || 0) + 1);
    }
  }
  assert.strictEqual(found.size, 8, '应当恰好得到 8 个环');
  for (const [key, count] of found) {
    assert.strictEqual(count, 2, `环 ${key} 的两个端点都应当能推出对方`);
  }
  // 每个环的半径都应当是 1 或 2 格
  for (const circle of R.CIRCLES) {
    const a = [Math.floor(circle.a / SIZE), circle.a % SIZE];
    const radius = Math.hypot(a[1] - circle.cc, a[0] - circle.cr);
    assert.ok(near(radius, 1) || near(radius, 2), '环半径必须是 1 或 2 格');
  }
});

check('随机局面下两个实现的吃子目标完全一致', () => {
  const rng = makeRng(20240607);
  let compared = 0, captures = 0;
  for (let trial = 0; trial < 4000; trial++) {
    const board = randomBoard(rng);
    for (let cell = 0; cell < CELLS; cell++) {
      const side = board[cell];
      if (side === EMPTY) continue;
      for (let d = 0; d < 4; d++) {
        const a = R.walkCapture(board, side, cell, d);
        const b = captureByAngles(board, side, cell, d);
        assert.strictEqual(a, b,
          `局面 ${trial}：(${Math.floor(cell / SIZE)},${cell % SIZE}) 方向 ${d} ` +
          `查表得 ${a}，几何计算得 ${b}\n` + R.boardToString(board));
        compared++;
        if (a >= 0) captures++;
      }
    }
  }
  console.log(`      对比 ${compared} 组（棋子, 方向），其中 ${captures} 组可以吃子`);
  assert.ok(captures > 200, '随机局面里应当出现足够多的可吃情形，否则说明覆盖不足');
});

check('随机局面下绕行路径经过的交叉点也完全一致', () => {
  const rng = makeRng(987654321);
  let compared = 0, longest = 0;
  for (let trial = 0; trial < 1200; trial++) {
    const board = randomBoard(rng);
    for (let cell = 0; cell < CELLS; cell++) {
      const side = board[cell];
      if (side === EMPTY) continue;
      for (let d = 0; d < 4; d++) {
        const a = R.traceCapturePath(board, side, cell, d);
        const b = traceByAngles(board, side, cell, d);
        assert.strictEqual(a.to, b.to, `局面 ${trial}：(${Math.floor(cell / SIZE)},${cell % SIZE}) 方向 ${d} 的吃子目标不一致`);
        // 查表版的多段线在交叉点处的坐标应当与几何版逐点吻合
        const onGrid = a.poly.filter(p => isInt(p.x) && isInt(p.y));
        assert.deepStrictEqual(
          onGrid.map(p => p.y * SIZE + p.x),
          b.cells,
          `局面 ${trial}：(${Math.floor(cell / SIZE)},${cell % SIZE}) 方向 ${d} 的路径不一致`);
        compared++;
        longest = Math.max(longest, b.cells.length);
      }
    }
  }
  console.log(`      对比 ${compared} 条路径，最长一条经过 ${longest} 个交叉点`);
});

check('只有四个角点无法发起吃子，最外圈上的环端点仍可绕环', () => {
  const corners = [0, SIZE - 1, (SIZE - 1) * SIZE, CELLS - 1];
  const rng = makeRng(13579);
  for (let trial = 0; trial < 600; trial++) {
    const board = randomBoard(rng);
    for (const corner of corners) {
      if (board[corner] === EMPTY) continue;
      for (let d = 0; d < 4; d++) {
        assert.strictEqual(R.walkCapture(board, board[corner], corner, d), -1,
          `角点 (${Math.floor(corner / SIZE)},${corner % SIZE}) 不应能够发起吃子`);
      }
    }
  }

  // 八个环的 16 个端点全部落在最外圈上：它们各自都能绕环吃到出环后的第一枚敌子
  const terminals = [];
  for (let cell = 0; cell < CELLS; cell++) if (R.LOOP_PARTNER[cell] >= 0) terminals.push(cell);
  assert.strictEqual(terminals.length, 16, '八个环应当有 16 个端点');
  for (const t of terminals) {
    const r0 = Math.floor(t / SIZE), c0 = t % SIZE;
    assert.ok(r0 === 0 || r0 === SIZE - 1 || c0 === 0 || c0 === SIZE - 1,
      `环端点 (${r0},${c0}) 应当位于棋盘最外圈`);
    const partner = R.LOOP_PARTNER[t];
    const exitDir = R.LOOP_EXIT_DIR[partner];
    const tr = Math.floor(partner / SIZE) + R.LINE_DR[exitDir];
    const tc = partner % SIZE + R.LINE_DC[exitDir];
    assert.ok(R.inBoard(tr, tc), '出环后应当落回棋盘内');
    const target = tr * SIZE + tc;
    const board = new Int8Array(CELLS);
    board[t] = BLACK;
    board[target] = RED;
    let hit = -1;
    for (let d = 0; d < 4; d++) if (R.walkCapture(board, BLACK, t, d) === target) hit = d;
    assert.ok(hit >= 0,
      `位于最外圈的环端点 (${r0},${c0}) 应当能绕环吃到出环后紧邻的敌子`);
  }
  console.log(`      四个角点均无法吃子；${terminals.length} 个环端点（全在最外圈）均可绕环吃子`);
});

console.log(`全部 ${passed} 项几何交叉验证通过。`);
