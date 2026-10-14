'use strict';
/* 苏拉卡尔塔规则引擎测试（node tests/rules.test.js） */

const R = require('../js/rules.js');
const assert = require('assert');
const { spawnSync } = require('node:child_process');

const idx = R.idx, BLACK = R.BLACK, RED = R.RED;
let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('  通过：' + name);
}

function emptyBoard() { return new Int8Array(R.CELLS); }

console.log('规则引擎测试');

check('八个角环的端点配对符合棋盘几何', () => {
  const expected = [
    [idx(0, 1), idx(1, 0)],
    [idx(0, 2), idx(2, 0)],
    [idx(0, 4), idx(1, 5)],
    [idx(0, 3), idx(2, 5)],
    [idx(5, 1), idx(4, 0)],
    [idx(5, 2), idx(3, 0)],
    [idx(5, 4), idx(4, 5)],
    [idx(5, 3), idx(3, 5)]
  ];
  assert.strictEqual(R.CIRCLES.length, 8, '应当恰好有 8 个环');
  const got = R.CIRCLES.map(c => [Math.min(c.a, c.b), Math.max(c.a, c.b)]);
  const want = expected.map(p => [Math.min(p[0], p[1]), Math.max(p[0], p[1])]);
  const key = p => p.join('-');
  assert.deepStrictEqual(got.map(key).sort(), want.map(key).sort());
  // 最外侧的四角没有环
  for (const cell of [idx(0, 0), idx(0, 5), idx(5, 0), idx(5, 5)]) {
    assert.strictEqual(R.LOOP_PARTNER[cell], -1, '角点不应带环');
  }
});

check('环端点回到棋盘的内向方向正确', () => {
  assert.strictEqual(R.LOOP_EXIT_DIR[idx(0, 1)], R.DIR_DOWN);
  assert.strictEqual(R.LOOP_EXIT_DIR[idx(1, 0)], R.DIR_RIGHT);
  assert.strictEqual(R.LOOP_EXIT_DIR[idx(5, 4)], R.DIR_UP);
  assert.strictEqual(R.LOOP_EXIT_DIR[idx(4, 5)], R.DIR_LEFT);
});

check('内侧回路为第 1、4 行与第 1、4 列，外侧回路为第 2、3 行与第 2、3 列', () => {
  const inner = R.CIRCLES.filter(c => c.radius === 1);
  const outer = R.CIRCLES.filter(c => c.radius === 2);
  assert.strictEqual(inner.length, 4);
  assert.strictEqual(outer.length, 4);
  // 沿内侧回路绕行一圈应当回到起点，并且只经过第 1、4 行与第 1、4 列
  let cur = idx(1, 0), dir = R.DIR_RIGHT;
  const seen = new Set();
  for (let step = 0; step < 40; step++) {
    const r = R.rowOf(cur), c = R.colOf(cur);
    assert.ok(R.INNER_LINES.includes(r) || R.INNER_LINES.includes(c), `内侧回路不应经过 (${r},${c})`);
    seen.add(cur);
    // 沿直线前进一格，越界则走环
    let nr = r + R.LINE_DR[dir], nc = c + R.LINE_DC[dir];
    if (R.inBoard(nr, nc)) {
      cur = idx(nr, nc);
    } else {
      const p = R.LOOP_PARTNER[cur];
      assert.ok(p >= 0, '内侧回路端点必须带环');
      cur = p;
      dir = R.LOOP_EXIT_DIR[p];
    }
    if (cur === idx(1, 0) && dir === R.DIR_RIGHT) break;
  }
  assert.strictEqual(cur, idx(1, 0));
  assert.strictEqual(dir, R.DIR_RIGHT, '内侧回路应当闭合');
  // 第 1、4 行各 6 点，第 1、4 列各 6 点，四处交叉点重复计算一次
  assert.strictEqual(seen.size, 12 + 12 - 4, '内侧回路应当经过 20 个交叉点');
});

check('开局双方各有 16 步普通走子与 0 个吃子', () => {
  const board = R.initialBoard();
  const counts = R.countPieces(board);
  assert.strictEqual(counts.black, 12);
  assert.strictEqual(counts.red, 12);
  for (const side of [BLACK, RED]) {
    const quiet = R.generateMoves(board, side, false);
    const caps = R.generateMoves(board, side, true);
    assert.strictEqual(quiet.length, 16, '开局普通走子数');
    assert.strictEqual(caps.length, 0, '开局不应有吃子');
  }
});

check('吃子必须绕过至少一个环：同行直线相遇不能吃', () => {
  const board = emptyBoard();
  board[idx(1, 1)] = BLACK;
  board[idx(1, 4)] = RED;
  assert.strictEqual(R.walkCapture(board, BLACK, idx(1, 1), R.DIR_RIGHT), -1,
    '同一直线上未绕环遇到的敌子不能吃');
  assert.strictEqual(R.walkCapture(board, BLACK, idx(1, 1), R.DIR_LEFT), idx(1, 4),
    '沿左侧绕环一周后可以吃到该敌子');
});

check('绕环后可以吃到紧邻的敌子', () => {
  const board = emptyBoard();
  board[idx(1, 1)] = BLACK;
  board[idx(2, 1)] = RED;   // 正下方
  assert.strictEqual(R.walkCapture(board, BLACK, idx(1, 1), R.DIR_DOWN), -1, '直接向下吃不到');
  assert.strictEqual(R.walkCapture(board, BLACK, idx(1, 1), R.DIR_LEFT), idx(2, 1),
    '先绕左上角环再沿第 1 列下行即可吃到');
});

check('外侧回路同样可以构成吃子路径', () => {
  const board = emptyBoard();
  board[idx(2, 2)] = BLACK;
  board[idx(2, 4)] = RED;
  assert.strictEqual(R.walkCapture(board, BLACK, idx(2, 2), R.DIR_RIGHT), -1);
  assert.strictEqual(R.walkCapture(board, BLACK, idx(2, 2), R.DIR_LEFT), idx(2, 4),
    '沿外侧回路绕行一周后可以吃到');
});

check('角上的棋子无法发起吃子', () => {
  for (const corner of [idx(0, 0), idx(0, 5), idx(5, 0), idx(5, 5)]) {
    for (const dir of [R.DIR_RIGHT, R.DIR_LEFT, R.DIR_DOWN, R.DIR_UP]) {
      assert.strictEqual(R.walkCapture(emptyBoard(), BLACK, corner, dir), -1);
    }
  }
  const board = emptyBoard();
  board[idx(0, 0)] = BLACK;
  board[idx(2, 0)] = RED;
  assert.deepStrictEqual(R.movesFrom(board, BLACK, idx(0, 0)).filter(m => m.capture), []);
});

check('切向规则：沿最外侧的列直行时不会拐进侧面的环', () => {
  const board = emptyBoard();
  board[idx(1, 0)] = BLACK;
  board[idx(0, 1)] = RED;
  assert.strictEqual(R.walkCapture(board, BLACK, idx(1, 0), R.DIR_UP), -1,
    '沿第 0 列上行只经过 (0,0)，此处没有环，不能拐去吃 (0,1)');
  assert.strictEqual(R.walkCapture(board, BLACK, idx(1, 0), R.DIR_LEFT), idx(0, 1),
    '沿第 1 行向左出界才会进入左上角的内环，随后可以吃到 (0,1)');
});

check('己方棋子挡路时不能吃，也不能跳子', () => {
  const board = emptyBoard();
  board[idx(1, 1)] = BLACK;
  board[idx(2, 1)] = BLACK;   // 己方棋子挡在绕环后的路径上
  board[idx(3, 1)] = RED;
  assert.strictEqual(R.walkCapture(board, BLACK, idx(1, 1), R.DIR_LEFT), -1);
});

check('绕行路径可以重复经过同一个空点且能正常终止', () => {
  const board = emptyBoard();
  board[idx(1, 2)] = BLACK;
  board[idx(4, 4)] = RED;
  const t0 = Date.now();
  const moves = R.movesFrom(board, BLACK, idx(1, 2));
  assert.ok(Date.now() - t0 < 1000, '路径搜索必须终止');
  const captures = moves.filter(m => m.capture).map(m => m.to);
  assert.ok(captures.includes(idx(4, 4)), '应当能沿回路绕到 (4,4)');
  // 空棋盘中央的棋子不该有任何吃子
  const empty = emptyBoard();
  empty[idx(2, 2)] = BLACK;
  for (const dir of [R.DIR_RIGHT, R.DIR_LEFT, R.DIR_DOWN, R.DIR_UP]) {
    assert.strictEqual(R.walkCapture(empty, BLACK, idx(2, 2), dir), -1);
  }
});

check('普通走子只走八邻域的空点', () => {
  const board = emptyBoard();
  board[idx(2, 2)] = BLACK;
  board[idx(3, 3)] = RED;
  const moves = R.movesFrom(board, BLACK, idx(2, 2)).filter(m => !m.capture);
  assert.strictEqual(moves.length, 7);
  for (const m of moves) {
    assert.ok(Math.abs(R.rowOf(m.to) - 2) <= 1 && Math.abs(R.colOf(m.to) - 2) <= 1);
    assert.strictEqual(board[m.to], R.EMPTY);
  }
});

check('吃子路径追踪与实际走子结果一致', () => {
  const board = emptyBoard();
  board[idx(1, 1)] = BLACK;
  board[idx(2, 1)] = RED;
  const path = R.traceCapturePath(board, BLACK, idx(1, 1), R.DIR_LEFT);
  assert.strictEqual(path.to, idx(2, 1));
  assert.ok(path.poly.length > 4, '路径应当包含绕环的圆弧采样点');
  const move = R.packMove(idx(1, 1), idx(2, 1));
  assert.strictEqual(R.applyMove(board, move), RED);
  assert.strictEqual(board[idx(1, 1)], R.EMPTY);
  assert.strictEqual(board[idx(2, 1)], BLACK);
});

check('棋盘左右镜像后走子数一致', () => {
  const board = emptyBoard();
  board[idx(1, 1)] = BLACK;
  board[idx(3, 4)] = BLACK;
  board[idx(2, 0)] = RED;
  board[idx(4, 2)] = RED;
  board[idx(2, 2)] = RED;
  const mirror = emptyBoard();
  for (let r = 0; r < R.SIZE; r++) {
    for (let c = 0; c < R.SIZE; c++) {
      mirror[idx(r, R.SIZE - 1 - c)] = board[idx(r, c)];
    }
  }
  const a = R.generateMoves(board, BLACK, false).length;
  const b = R.generateMoves(mirror, BLACK, false).length;
  assert.strictEqual(a, b);
});

/*
 * 绕行的循环检测在代数计数器超过 2^31 之后必须仍然有效。
 *
 * 这是实测出来的一个真 bug：visitStamp 原本是 Int32Array，而代数在整个进程里单调递增
 * （AI 每搜一个节点要绕行几十次），跑上几分钟就过 2^31。写入时被截断成负数、读回来的
 * gen 却是正数，「这一趟走过这个格子」再也匹配不上，保护失效——walkCapture 真的转不出来，
 * 表现是 AI 搜索卡死、CPU 100%、棋再也走不动。下面的局面就是实测中卡住的那一个。
 *
 * 这一项放在子进程里跑：万一有人把 Float64Array 改回 Int32Array，它会**卡住**而不是断言失败，
 * 子进程超时就能把它变成一个明确的失败，而不是让整个测试挂在那里。
 */
check('绕行检测在代数超过 2^31 后依然有效（不会转不出来）', () => {
  const script = `
    const R = require(${JSON.stringify(require.resolve('../js/rules.js'))});
    R.__setVisitGenForTest(2159841075);          // 实测的溢出点位
    const board = Int8Array.from('101101000000102101002200000000212202'.split('').map(Number));
    const out = [];
    for (let from = 0; from < R.CELLS; from++) {
      const list = R.movesFrom(board, 1, from);   // 卡住的话这里永远回不来
      out.push(list.length);
      R.traceCapturePath(board, 1, from, 0);      // 画面预览用的是同一条路
    }
    console.log(JSON.stringify({ moves: R.generateMoves(board, 1, false).length,
                                 cells: out.reduce((a, b) => a + b, 0) }));
  `;
  const res = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 20000 });
  assert.ok(!res.error || res.error.code !== 'ETIMEDOUT',
    '绕行路径转不出来了——visitStamp 是不是又被改回会截断大数的整数数组了？');
  assert.strictEqual(res.status, 0, '子进程异常：' + (res.stderr || ''));
  const got = JSON.parse(res.stdout.trim());
  assert.ok(got.moves > 0 && got.cells > 0, '代数很大时着法生成也必须照常返回结果');
});

check('随机局面下着法生成自洽且无重复', () => {
  let seed = 12345;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let round = 0; round < 300; round++) {
    const board = emptyBoard();
    for (let cell = 0; cell < R.CELLS; cell++) {
      const roll = rnd();
      if (roll < 0.55) continue;
      board[cell] = roll < 0.78 ? BLACK : RED;
    }
    for (const side of [BLACK, RED]) {
      const moves = R.generateMoves(board, side, false);
      assert.strictEqual(new Set(moves).size, moves.length, '着法列表中不应有重复');

      // 逐枚棋子枚举的结果必须与整体生成完全一致
      const perPiece = new Set();
      for (let from = 0; from < R.CELLS; from++) {
        if (board[from] !== side) continue;
        for (const info of R.movesFrom(board, side, from)) perPiece.add(info.move);
      }
      assert.strictEqual(perPiece.size, moves.length, '两种枚举方式结果数量不一致');
      for (const move of moves) assert.ok(perPiece.has(move), '整体生成出现了逐子枚举没有的着法');

      for (const move of moves) {
        const from = R.moveFrom(move), to = R.moveTo(move);
        assert.strictEqual(board[from], side, '起点必须是己方棋子');
        assert.notStrictEqual(from, to);
        if (board[to] !== R.EMPTY) {
          assert.strictEqual(board[to], 3 - side, '吃子目标必须是敌方棋子');
        } else {
          assert.ok(Math.abs(R.rowOf(to) - R.rowOf(from)) <= 1 &&
            Math.abs(R.colOf(to) - R.colOf(from)) <= 1, '普通走子必须走八邻域');
        }
      }
      // 吃子着法的集合必须与专门的吃子生成器一致
      const caps = R.generateMoves(board, side, true);
      const capsFromAll = moves.filter(m => board[R.moveTo(m)] !== R.EMPTY);
      assert.strictEqual(caps.length, capsFromAll.length, '吃子着法数量不一致');
      assert.strictEqual(new Set(caps.concat(capsFromAll)).size, caps.length);
    }
  }
});

console.log(`全部 ${passed} 项规则测试通过。`);
