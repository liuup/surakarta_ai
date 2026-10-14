'use strict';
/*
 * 终端界面测试（node tests/tui.test.js）
 *
 * 真实启动 server.js，再把 tui.js 当作子进程跑起来，喂给它按键，检查它画出来的字符。
 * 用的是 --plain（纯 ASCII、不着色），这样输出可以逐字符比对。
 *
 * 这里盯的主要是「排版」——终端界面最容易出的错不是逻辑错，而是画歪了：
 * 一行超出屏幕宽度会被折行，整个面板就散了；帮助页多一行就会被切掉。
 * 所以宽度是按**显示宽度**算的（汉字与全角符号占 2 列），不是按字符串长度。
 */
const assert = require('assert');
const { spawn } = require('node:child_process');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const I18N = require(path.join(ROOT, 'js/i18n.js'));
const PORT = 8800 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}`;
const WIDTH = 80;                 // 非 tty 时 tui.js 默认按 80×24 排版

let passed = 0;
function check(name, fn) {
  return Promise.resolve().then(fn).then(() => {
    passed++;
    console.log('  通过：' + name);
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 一个字符在终端里占几列：东亚宽字符占 2 列 */
function charWidth(ch) {
  const c = ch.codePointAt(0);
  const wide =
    (c >= 0x1100 && c <= 0x115f) ||        // 谚文字母
    (c >= 0x2e80 && c <= 0xa4cf) ||        // 部首、假名、汉字、注音…
    (c >= 0xac00 && c <= 0xd7a3) ||        // 谚文音节
    (c >= 0xf900 && c <= 0xfaff) ||        // 兼容汉字
    (c >= 0xfe30 && c <= 0xfe6f) ||        // 竖排标点、小写变体
    (c >= 0xff00 && c <= 0xff60) ||        // 全角字符
    (c >= 0xffe0 && c <= 0xffe6);          // 全角符号
  return wide ? 2 : 1;
}
const displayWidth = text => Array.from(text).reduce((n, ch) => n + charWidth(ch), 0);
const widestLine = text => text.split('\n').reduce((m, l) => Math.max(m, displayWidth(l)), 0);

/** 按显示列截断（汉字算 2 列），不是按字符个数 */
function sliceCols(text, cols) {
  let used = 0, out = '';
  for (const ch of text) {
    const w = charWidth(ch);
    if (used + w > cols) break;
    out += ch;
    used += w;
  }
  return out;
}

/*
 * 取出棋盘那一块。棋盘固定画在左侧 23 个显示列里，右边第 24 列起才是面板文字，
 * 所以先按显示列切开、再只留画了棋盘线的行——这样比对的就纯粹是棋子与线，
 * 与右侧是哪种语言无关。
 */
const PANEL_COL = 23;
const BOARD_LINE = /^[\s/\\|+\-o.*^BR]+$/;

/*
 * 棋盘上每个线字形伸出的「胳膊」指向哪几格。
 * 用来验证折线是连通的：方角悬空、或者一根线断在空格里，都是栅格化出错的症状。
 * ─ 和 │ 各有两个相反的胳膊；┌ ┐ └ ┘ 各管一个横胳膊和一个竖胳膊；┼ 四个都有。
 */
const ARMS = {
  '─': [[-1, 0], [1, 0]], '│': [[0, -1], [0, 1]],
  '┌': [[1, 0], [0, 1]], '┐': [[-1, 0], [0, 1]],
  '└': [[1, 0], [0, -1]], '┘': [[-1, 0], [0, -1]],
  '┼': [[-1, 0], [1, 0], [0, -1], [0, 1]]
};
const LINE_GLYPH = new Set(Object.keys(ARMS));

/** 返回棋盘区里所有不连通的地方（空数组表示全连通） */
function brokenArms(out) {
  const grid = out.split('\n').map(line => Array.from(sliceCols(line, PANEL_COL)));
  const at = (x, y) => (grid[y] && grid[y][x]) || ' ';
  const bad = [];
  for (let y = 0; y < grid.length; y++) {
    for (let x = 0; x < grid[y].length; x++) {
      const glyph = grid[y][x];
      if (!LINE_GLYPH.has(glyph)) continue;
      for (const [dx, dy] of ARMS[glyph]) {
        const n = at(x + dx, y + dy);
        if (n === ' ') { bad.push(`(${x},${y}) 的 ${glyph} 有一头指向空格`); continue; }
        if (LINE_GLYPH.has(n) && !ARMS[n].some(([bx, by]) => bx === -dx && by === -dy)) {
          bad.push(`(${x},${y}) 的 ${glyph} 与 (${x + dx},${y + dy}) 的 ${n} 接不上`);
        }
      }
    }
  }
  return bad;
}
const boardOf = text => text.split('\n')
  .map(line => sliceCols(line, PANEL_COL))
  .filter(line => BOARD_LINE.test(line))
  .join('\n');

/** 跑一次 tui.js：喂按键，收输出。extraEnv 可以指定屏幕尺寸（COLUMNS / LINES） */
function runTUI(args, keys, timeoutMs = 20000, extraEnv = null) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['tui.js', ...args], {
      cwd: ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: extraEnv ? Object.assign({}, process.env, extraEnv) : process.env
    });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('tui.js 超时未退出')); }, timeoutMs);
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
    child.stdin.end(keys + 'q');
  });
}

async function api(route, body) {
  const res = await fetch(BASE + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return res.json();
}

async function waitForServer(timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { if ((await fetch(BASE + '/api/state')).ok) return; } catch (e) { /* 还没起来 */ }
    if (Date.now() > deadline) throw new Error('后端服务未能启动');
    await sleep(120);
  }
}

const CJK = /[⺀-鿿]/;

async function main() {
  console.log('终端界面测试');
  const server = spawn(process.execPath, ['server.js', '--port', String(PORT)], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe']
  });

  try {
    await waitForServer();
    // 摆一局有内容的棋：人类走一步、AI 应一手，这样面板与着法记录都画得满
    await api('/api/new', { level: 0, humanSide: 1 });
    const state = await api('/api/state');
    await api('/api/move', { move: state.state.legal[0] });
    for (let i = 0; i < 100; i++) {
      const s = await api('/api/state');
      if (s.state.moves.length >= 2) break;
      await sleep(100);
    }

    let en = null, zh = null;

    await check('英文界面（默认）能正常启动退出，且不着色', async () => {
      en = await runTUI(['--server', BASE, '--plain'], '');
      assert.strictEqual(en.code, 0, '退出码应当是 0，实际 ' + en.code + ' stderr=' + en.err);
      assert.ok(!en.out.includes('\x1b'), '--plain 不应当输出 ANSI 转义序列');
      assert.ok(en.out.includes('Surakarta') && en.out.includes('You play'), '应当画出英文面板');
    });

    await check('英文 --plain 的输出是纯 ASCII（终端不认 Unicode 时也能看）', () => {
      const nonAscii = [...new Set(Array.from(en.out).filter(c => c.codePointAt(0) > 127))];
      assert.deepStrictEqual(nonAscii, [], '残留的非 ASCII 字符：' + nonAscii.join(' '));
    });

    await check('--lang zh 能切成中文，且棋盘照旧', async () => {
      zh = await runTUI(['--server', BASE, '--plain', '--lang', 'zh'], '');
      assert.strictEqual(zh.code, 0);
      assert.ok(!zh.out.includes('\x1b'));
      assert.ok(CJK.test(zh.out), '中文界面上应当有汉字');
      // 两种语言画的棋盘必须一模一样（换的只是四周的文字）
      assert.strictEqual(boardOf(zh.out), boardOf(en.out), '中英文的棋盘不应有差异');
    });

    await check('两种语言的着法记录是同一手棋', () => {
      // --plain 下箭头会换成 ->，所以两种写法都要认
      const moves = text => (text.match(/[BR黑红] [a-f][1-6](?:→|->)[a-f][1-6]/g) || [])
        .map(m => m.replace(/^黑/, 'B').replace(/^红/, 'R').replace('->', '→'));
      const enMoves = moves(en.out);
      const zhMoves = moves(zh.out);
      assert.ok(enMoves.length >= 2, '应当画出着法记录：' + JSON.stringify(enMoves));
      assert.deepStrictEqual(zhMoves, enMoves, '中英文的着法记录应当逐手对应');
    });

    await check(`两种语言都不超过 ${WIDTH} 列宽`, () => {
      assert.ok(widestLine(en.out) <= WIDTH, `英文最宽 ${widestLine(en.out)} 列`);
      assert.ok(widestLine(zh.out) <= WIDTH, `中文最宽 ${widestLine(zh.out)} 列`);
    });

    await check('棋盘只用横竖笔画，没有斜线', async () => {
      // 终端里一个字符约「半格宽、一格高」，斜线拼出的圆弧永远对不齐，
      // 所以角环的折线只用 ─ │ ┌ ┐ └ ┘（ASCII 模式是 - | +）。
      const uni = await runTUI(['--server', BASE, '--no-color'], '');
      const boardRegion = text => text.split('\n').map(l => sliceCols(l, PANEL_COL)).join('\n');
      assert.ok(!/[╱╲]/.test(boardRegion(uni.out)), '棋盘上出现了斜线字形 ╱ ╲');
      assert.ok(!/[/\\]/.test(boardRegion(en.out)), '--plain 的棋盘上出现了 / 或 \\');
      assert.ok(/[┌┐└┘]/.test(boardRegion(uni.out)), '角环应当用方角画出来');
    });

    await check('棋盘上的折线互相连通：方角不悬空、线不断在空格里', async () => {
      for (const args of [['--server', BASE, '--no-color'], ['--server', BASE, '--plain']]) {
        const { out } = await runTUI(args, '');
        const bad = brokenArms(out);
        assert.deepStrictEqual(bad, [], args.includes('--plain') ? '--plain：' : 'Unicode：');
      }
    });

    await check('按 L 当场切换语言（小写 l 不切换）', async () => {
      const flipped = await runTUI(['--server', BASE, '--plain'], 'L');
      assert.ok(flipped.out.includes('Surakarta'), '第一帧应当是英文');
      assert.ok(CJK.test(flipped.out), '按 L 之后应当出现中文');
      const lower = await runTUI(['--server', BASE, '--plain'], 'l');
      assert.ok(!CJK.test(lower.out), '小写 l 只是把光标右移，不应切换语言');
    });

    await check('对着同一枚棋子再按一次 Enter 就取消选中', async () => {
      // --plain 模式下每帧之间用一行 --- 分隔，看最后一帧即可
      const framesOf = async keys => {
        const { out } = await runTUI(['--server', BASE, '--no-color'], keys);
        return out.split(/\n-{8,}\n/);
      };
      const lastFrame = frames => frames[frames.length - 1];
      const showsSelection = frame => /Selected \S+ \(\d+ destinations\)/.test(frame);

      await api('/api/new', { level: 0, humanSide: 1 });
      const once = await framesOf('\r');
      assert.ok(showsSelection(lastFrame(once)), '按一次 Enter 应当选中棋子并列出落点');

      const twice = await framesOf('\r\r');
      assert.ok(!showsSelection(lastFrame(twice)), '再按一次应当收起落点提示');
      assert.ok(!/▸/.test(lastFrame(twice)), '取消选中后不该还留着落点列表');

      const thrice = await framesOf('\r\r\r');
      assert.ok(showsSelection(lastFrame(thrice)), '第三次应当重新选中——这是切换，不是单向取消');
    });

    await check('--plain 在选中、思考、报错时也仍然是纯 ASCII', async () => {
      // 这几个字形只在特定状态下才出现，最初写的纯 ASCII 检查漏掉了它们
      const nonAscii = out => [...new Set(Array.from(out).filter(c => c.codePointAt(0) > 127))];

      await api('/api/new', { level: 0, humanSide: 1 });
      const selected = await runTUI(['--server', BASE, '--plain'], '\r');       // 落点列表用 ▸
      assert.deepStrictEqual(nonAscii(selected.out), [], '选中棋子时：');

      const banner = await runTUI(['--server', BASE, '--plain'], 'u');          // 无棋可悔 → 报错横幅 ✖
      assert.deepStrictEqual(nonAscii(banner.out), [], '报错横幅时：');

      // AI 先行的局面，进去时它正在思考 → 进度条 █ ░ 与「准备中…」
      // 用最慢的一档，确保启动终端时它确实还在想（否则这一项会空跑）
      await api('/api/new', { level: 3, humanSide: 2 });
      const thinking = await runTUI(['--server', BASE, '--plain'], 'j');
      assert.deepStrictEqual(nonAscii(thinking.out), [], 'AI 思考中时：');
      assert.ok(/[#-]{10}/.test(thinking.out), '应当捕捉到思考进度条（这一项才有意义）');
      await api('/api/new', { level: 0, humanSide: 1 });
    });

    await check('帮助浮层在中英文下都完整、不超宽、不被切掉', async () => {
      const enHelp = await runTUI(['--server', BASE, '--plain'], '?');
      const zhHelp = await runTUI(['--server', BASE, '--plain', '--lang', 'zh'], '?');
      for (const [tag, run] of [['英文', enHelp], ['中文', zhHelp]]) {
        const overlay = run.out.split('\n').filter(l => l.trim());
        assert.ok(widestLine(run.out) <= WIDTH, tag + '帮助页最宽 ' + widestLine(run.out) + ' 列');
        assert.ok(/press any key|按任意键/.test(run.out), tag + '帮助页应当有「按任意键返回」那一行');
      }
      // 玩法那一段是整句，被裁掉的话结尾几个词就没了——这正是宽度不够时的典型症状
      assert.ok(enHelp.out.includes('Capture all 12 pieces to win.'), '英文玩法的结尾被截断了');
      assert.ok(zhHelp.out.includes('吃光对方 12 枚棋子即获胜。'), '中文玩法的结尾被截断了');
      assert.ok(enHelp.out.includes('L (zh / English)'), '帮助里应当说明 L 键');
      const nonAscii = [...new Set(Array.from(enHelp.out).filter(c => c.codePointAt(0) > 127))];
      assert.deepStrictEqual(nonAscii, [], 'ASCII 模式的帮助页仍有非 ASCII：' + nonAscii.join(' '));
    });

    await check('--help 打出用法，且跟随 --lang', async () => {
      const usage = await runTUI(['--help'], '');
      assert.strictEqual(usage.code, 0);
      assert.ok(/--port/.test(usage.out) && /--lang/.test(usage.out), '用法里应当列出参数');
      const zhUsage = await runTUI(['--help', '--lang', 'zh'], '');
      assert.ok(CJK.test(zhUsage.out), '中文用法说明里应当有汉字');
    });

    await check('后端连不上时报错清楚、按当前语言、退出码为 1', async () => {
      const dead = 'http://127.0.0.1:1';
      const enFail = await runTUI(['--server', dead, '--plain'], '');
      const zhFail = await runTUI(['--server', dead, '--plain', '--lang', 'zh'], '');
      assert.strictEqual(enFail.code, 1, '连不上后端应当以 1 退出，实际 ' + enFail.code);
      assert.strictEqual(zhFail.code, 1);
      // 报错走 stderr（命令行程序的惯例），stdout 上不该画出半个棋盘
      assert.ok(!enFail.out.includes('\x1b') && enFail.out.trim() === '', 'stdout 应当保持干净');
      assert.ok(/Cannot reach the Surakarta backend/.test(enFail.err), '应当说明连不上哪个地址：' + enFail.err.slice(0, 80));
      assert.ok(/server\.js/.test(enFail.err), '应当提示怎么把后端启动起来');
      assert.ok(CJK.test(zhFail.err) && !CJK.test(enFail.err), '报错信息应当跟随语言');
    });

    await check('屏幕太小时给出提示而不是画出乱码', async () => {
      const { code, out } = await runTUI(['--server', BASE, '--plain'], '', 20000, { COLUMNS: '30', LINES: '10' });
      assert.strictEqual(code, 0);
      assert.ok(/Terminal too small/.test(out), '应当提示屏幕太小：' + JSON.stringify(out.slice(0, 120)));
      assert.ok(/34×16|34.16/.test(out), '应当说出至少需要多大：' + JSON.stringify(out.slice(0, 160)));
      assert.ok(!/\| \\ R-R/.test(out), '屏幕放不下时不该硬画棋盘');
      assert.ok(widestLine(out) <= 30, '提示本身也不该超出 30 列，实际 ' + widestLine(out));
    });

    await check('80×24 放得下完整的棋盘与面板', async () => {
      const { out } = await runTUI(['--server', BASE, '--plain'], '', 20000, { COLUMNS: '80', LINES: '24' });
      assert.ok(/Moves|B [a-f][1-6]→/.test(out), '应当画出着法记录');
      assert.ok(out.split('\n').filter(l => l.trim()).length <= 24, '不该超过 24 行');
      assert.ok(widestLine(out) <= 80);
    });

    await check('后端与终端看的是同一局棋', async () => {
      // 用接口走一步（相当于另一个界面走棋），终端重新打开就应当看到这一步
      const before = await api('/api/state');
      const move = before.state.legal[0];
      await api('/api/move', { move });
      const after = await runTUI(['--server', BASE, '--plain'], '');
      // 着法记录区只画最后几手，所以按「这一手在不在」判断，而不是数条数
      const expected = I18N.formatMove('en', {
        side: before.state.side,
        from: move >> 6,
        to: move & 63,
        capture: false
      }).replace('→', '->');
      assert.ok(after.out.includes(expected), `终端应当显示 ${expected}：` + JSON.stringify(after.out.slice(-160)));
    });
  } finally {
    server.kill('SIGKILL');
    await sleep(150);
  }

  console.log(`\n全部 ${passed} 项终端界面测试通过。`);
}

main().catch(err => {
  console.error('\n终端界面测试失败：', err && err.stack || err);
  process.exit(1);
});
