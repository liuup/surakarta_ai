#!/usr/bin/env node
'use strict';
/*!
 * 苏拉卡尔塔（Surakarta）终端界面
 *
 *   node tui.js [--server http://127.0.0.1:8123] [--no-color] [--plain] [--lang zh|en]
 *
 * 本文件只做两件事：**显示**与**按键**。
 * 局面全部来自后端服务的 /api/… 接口，走子、悔棋、换难度也一律发给后端，
 * 本地不留任何对局状态、不判断合法性、更不跑 AI——因此终端和网页看到的是
 * 同一局棋（都住在 server.js 里），两边可以同时开着交替落子。
 *
 * js/rules.js 只用来做「画图」：棋盘线、角环圆弧、交叉点坐标。
 * 任何一步是否合法都由后端说了算。
 *
 * 所有给人看的文字都出自 js/i18n.js：默认英文，--lang zh 或按 L 键切中文。
 * 后端只给结构化数据（哪一方、从哪到哪、是否吃子、终局原因），由这里渲染成文字。
 *
 * 只依赖 Node 内置模块。按下 q 或 Ctrl+C 退出时会还原终端。
 */

const http = require('node:http');
const R = require('./js/rules.js');
const I18N = require('./js/i18n.js');

// ============================================================ 命令行参数

const DEFAULT_SERVER = 'http://127.0.0.1:8123';

/**
 * --help 的文本。命令与选项名各语言都一样，其余全部走 i18n，
 * 所以 --lang zh 也能看到中文帮助；按键说明直接复用帮助浮层里的词条，
 * 免得同一件事有两份翻译。
 */
function usageText(locale) {
  const t = (key, params) => I18N.t(locale, key, params);
  const lv = key => I18N.levelName(locale, key);
  const pad = (s, w) => s + ' '.repeat(Math.max(1, w - visibleWidth(s)));

  const options = [
    ['--server <url>', t('tui.usage.server', { url: DEFAULT_SERVER })],
    ['--no-color', t('tui.usage.noColor')],
    ['--plain', t('tui.usage.plain')],
    ['--lang <code>', t('tui.usage.lang')],
    ['-h, --help', t('tui.usage.help')]
  ];
  const keys = [
    [t('tui.help.move'), t('tui.help.moveKeys')],
    [t('tui.help.confirm'), t('tui.help.confirmKeys')],
    [t('tui.help.esc'), 'Esc'],
    [t('tui.help.new'), 'n'],
    [t('tui.help.undo'), t('tui.help.undoKeys')],
    [t('tui.help.side'), t('tui.help.sideKeys')],
    [t('tui.help.agree'), 'a'],
    [t('tui.help.level'), t('tui.help.levelKeys', { l1: lv(1), l2: lv(2), l3: lv(3), l4: lv(4) })],
    [t('tui.help.lang'), t('tui.help.langKeys')],
    [t('tui.help.help'), '?'],
    [t('tui.help.quit'), t('tui.help.quitKeys')]
  ];

  const optionW = options.reduce((w, r) => Math.max(w, r[0].length), 0) + 2;
  const keyW = keys.reduce((w, r) => Math.max(w, visibleWidth(r[0])), 0) + 2;
  const out = [t('tui.title'), '', t('tui.usage.line') + 'node tui.js [--server <url>] [--no-color] [--plain] [--lang zh|en]', '', t('tui.usage.options')];
  for (const [flag, text] of options) out.push('  ' + pad(flag, optionW) + text);
  out.push('', t('tui.usage.keys'));
  for (const [label, text] of keys) out.push('  ' + pad(label, keyW) + text);
  out.push('', t('tui.usage.needBackend'));
  return out.join('\n');
}

function parseArgs(argv) {
  const opts = { server: DEFAULT_SERVER, color: true, ascii: false, help: false, lang: I18N.DEFAULT_LOCALE };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if ((arg === '--server' || arg === '-s') && argv[i + 1]) opts.server = argv[++i];
    else if (arg === '--lang' && argv[i + 1]) opts.lang = I18N.normalize(argv[++i]);
    else if (arg === '--no-color') opts.color = false;
    else if (arg === '--plain') { opts.color = false; opts.ascii = true; }
    else if (arg === '--help' || arg === '-h') opts.help = true;
  }
  opts.server = String(opts.server).replace(/\/+$/, '');
  return opts;
}

const OPTS = parseArgs(process.argv.slice(2));

// 有颜色 ≠ 能定位光标：往管道里写日志时依然可以带色，
// 但只有当 stdin/stdout 都是终端时才使用备用屏幕与光标定位。
const COLOR = OPTS.color && !process.env.NO_COLOR;
const INTERACTIVE = COLOR && !!process.stdout.isTTY && !!process.stdin.isTTY;

// ============================================================ 字形与颜色

/** 画棋盘用的字形。plain 模式下退回到纯 ASCII */
const G = OPTS.ascii ? {
  hLine: '-', vLine: '|', cross: '+',
  black: 'B', red: 'R', loop: 'o', dot: '.', trail: '*', caret: '^',
  arcSE: '\\', arcNE: '/'
} : {
  hLine: '─', vLine: '│', cross: '┼',
  black: '●', red: '▲', loop: '○', dot: '◦', trail: '•', caret: '^',
  arcSE: '╲', arcNE: '╱'
};

/** 256 色索引与真彩色 RGB 两套配色 */
const PALETTE = {
  inner: { rgb: [56, 189, 248], c256: 45 },
  outer: { rgb: [74, 222, 128], c256: 41 },
  edge: { rgb: [140, 112, 80], c256: 137 },
  black: { rgb: [226, 232, 240], c256: 252 },
  red: { rgb: [248, 113, 113], c256: 203 },
  loop: { rgb: [244, 208, 63], c256: 220 },
  hint: { rgb: [125, 211, 252], c256: 117 },
  trail: { rgb: [251, 146, 60], c256: 214 },
  accent: { rgb: [147, 197, 253], c256: 111 },
  text: { rgb: [222, 226, 233], c256: 253 },
  dim: { rgb: [124, 130, 142], c256: 243 },
  ok: { rgb: [134, 239, 172], c256: 120 },
  warn: { rgb: [251, 191, 36], c256: 214 },
  err: { rgb: [248, 113, 113], c256: 203 },
  danger: { rgb: [127, 29, 29], c256: 88 }
};

const TRUECOLOR = /^(truecolor|24bit)$/i.test(process.env.COLORTERM || '');

/** 把一堆样式片段拼好，plain 模式下全部是空串 */
function makeStyles(enabled) {
  const fg = name => {
    if (!enabled) return '';
    const c = PALETTE[name];
    return TRUECOLOR
      ? `\x1b[38;2;${c.rgb.join(';')}m`
      : `\x1b[38;5;${c.c256}m`;
  };
  const bg = name => {
    if (!enabled) return '';
    const c = PALETTE[name];
    return TRUECOLOR
      ? `\x1b[48;2;${c.rgb.join(';')}m`
      : `\x1b[48;5;${c.c256}m`;
  };
  const attr = code => (enabled ? code : '');
  return {
    enabled,
    reset: attr('\x1b[0m'),
    bold: attr('\x1b[1m'),
    dim: attr('\x1b[2m'),
    underline: attr('\x1b[4m'),
    inverse: attr('\x1b[7m'),
    inner: fg('inner'),
    outer: fg('outer'),
    edge: fg('edge') + attr('\x1b[2m'),
    black: fg('black') + attr('\x1b[1m'),
    red: fg('red') + attr('\x1b[1m'),
    loop: fg('loop') + attr('\x1b[1m'),
    hint: fg('hint') + attr('\x1b[1m'),
    trail: fg('trail') + attr('\x1b[1m'),
    trailDim: fg('trail') + attr('\x1b[2m'),
    captureBg: bg('danger'),
    accent: fg('accent'),
    title: fg('accent') + attr('\x1b[1m'),
    text: fg('text'),
    dimText: fg('dim'),
    ok: fg('ok'),
    warn: fg('warn'),
    err: fg('err')
  };
}

const S = makeStyles(COLOR);

// ============================================================ 显示宽度
//
// 中文、全角标点在终端里占两格，排版时必须按「可见宽度」而不是
// 字符串长度来对齐，否则整个面板都会歪。

function charWidth(cp) {
  if (cp >= 0x1100 && (
    cp <= 0x115f ||
    cp === 0x2329 || cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  )) return 2;
  return 1;
}

const ANSI_RE = /^\x1b\[[0-9;]*m/;

function visibleWidth(str) {
  let width = 0;
  for (let i = 0; i < str.length;) {
    if (str[i] === '\x1b') {
      const m = ANSI_RE.exec(str.slice(i));
      if (m) { i += m[0].length; continue; }
    }
    const cp = str.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    width += charWidth(cp);
    i += ch.length;
  }
  return width;
}

/** 按可见宽度截断，保留其中的 ANSI 序列 */
function clipStyled(str, width) {
  let out = '', used = 0;
  for (let i = 0; i < str.length;) {
    if (str[i] === '\x1b') {
      const m = ANSI_RE.exec(str.slice(i));
      if (m) { out += m[0]; i += m[0].length; continue; }
    }
    const cp = str.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    const w = charWidth(cp);
    if (used + w > width) break;
    out += ch;
    used += w;
    i += ch.length;
  }
  return out;
}

/** 补齐到指定可见宽度（超出则截断），补的白空格不带样式 */
function padTo(str, width) {
  const have = visibleWidth(str);
  if (have === width) return str;
  if (have > width) return clipStyled(str, width) + S.reset;
  return str + S.reset + ' '.repeat(width - have);
}

function clipTo(str, width) {
  return visibleWidth(str) <= width ? str : clipStyled(str, width) + S.reset;
}

function repeatTo(ch, width) {
  return ch.repeat(Math.max(0, width));
}

// ============================================================ 棋盘几何
//
// 终端里一个字符约「半格宽、一格高」，所以横向每个交叉点用 STEP_X 个字符、
// 纵向用 STEP_Y 行，棋盘看上去才是方的。四周留出 MARGIN 格给角环圆弧。

const SIZE = R.SIZE;
const STEP_X = 2;
const STEP_Y = 1;
const ORIGIN_X = 5;                                    // 交叉点 (0,0) 的列
const ORIGIN_Y = 3;                                    // 交叉点 (0,0) 的行
const BOARD_W = ORIGIN_X * 2 + (SIZE - 1) * STEP_X + 1; // 21
const BOARD_H = ORIGIN_Y * 2 + (SIZE - 1) * STEP_Y + 1; // 12

// 绘制优先级：数字大的盖住数字小的
const P = {
  arc: 1, edge: 1, inner: 2, outer: 3,
  loop: 4, path: 5, pathActive: 6, hint: 7, piece: 8, cursor: 9
};

function cellX(cell) { return ORIGIN_X + R.colOf(cell) * STEP_X; }
function cellY(cell) { return ORIGIN_Y + R.rowOf(cell) * STEP_Y; }

/** 两条棋盘线的性质：最外侧没有环，1/4 是内回路，2/3 是外回路 */
function linePriority(index) {
  if (R.OUTER_LINES.indexOf(index) >= 0) return P.outer;
  if (R.INNER_LINES.indexOf(index) >= 0) return P.inner;
  return P.edge;
}
function lineStyle(index) {
  const p = linePriority(index);
  return p === P.outer ? S.outer : p === P.inner ? S.inner : S.edge;
}

/** 交叉点文字：列字母 + 行号；与后端给的结构化着法用的是同一套写法（与语言无关） */
function cellName(cell) {
  return I18N.cellName(cell, SIZE);
}

// ============================================================ 字符画布

function createCanvas(width, height, styles) {
  const ch = new Array(height);
  const st = new Array(height);
  const pr = new Array(height);
  for (let y = 0; y < height; y++) {
    ch[y] = new Array(width).fill(' ');
    st[y] = new Array(width).fill('');
    pr[y] = new Int16Array(width).fill(-1);
  }

  function put(x, y, glyph, style, prio) {
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    if (prio < pr[y][x]) return;
    ch[y][x] = glyph;
    st[y][x] = style || '';
    pr[y][x] = prio;
  }

  /** 沿两个字符坐标之间铺一串同样的字形（绕行路线靠它串成珠子） */
  function seg(x0, y0, x1, y1, style, prio, glyph) {
    const dx = x1 - x0, dy = y1 - y0;
    if (dx === 0 && dy === 0) return;
    const steps = Math.max(Math.abs(dx), Math.abs(dy));
    for (let i = 0; i <= steps; i++) {
      put(Math.round(x0 + dx * i / steps), Math.round(y0 + dy * i / steps), glyph, style, prio);
    }
  }

  function glyphAt(x, y) {
    return (x >= 0 && x < width && y >= 0 && y < height) ? ch[y][x] : ' ';
  }
  function styleAt(x, y) {
    return (x >= 0 && x < width && y >= 0 && y < height) ? st[y][x] : '';
  }

  /** 逐行输出；只在样式变化处写转义，避免每格都刷一大串 */
  function toLines() {
    const out = [];
    for (let y = 0; y < height; y++) {
      let line = '';
      let cur = '';
      for (let x = 0; x < width; x++) {
        if (st[y][x] !== cur) {
          if (styles.enabled) line += styles.reset;
          line += st[y][x];
          cur = st[y][x];
        }
        line += ch[y][x];
      }
      if (styles.enabled && cur !== '') line += styles.reset;
      out.push(line);
    }
    return out;
  }

  return { width, height, put, seg, glyphAt, styleAt, toLines };
}

// ============================================================ 绘制棋盘

/**
 * 圆弧上一点该用哪个字形：按曲线在那里的切向来挑 ─ │ ╲ ╱。
 * 棋盘一格在横竖两个方向上都是两个字符宽，所以网格坐标下的方向
 * 就是屏幕上的真实方向，直接比分量即可。
 */
function tangentGlyph(gx, gy) {
  const ax = Math.abs(gx), ay = Math.abs(gy);
  if (ay * 2 <= ax) return G.hLine;
  if (ax * 2 <= ay) return G.vLine;
  return (gx > 0) === (gy > 0) ? G.arcSE : G.arcNE;
}

/**
 * 八个角环的圆弧：半径 1 画内回路色，半径 2 画外回路色。
 * 逐格铺字形（同一格只落一次），这样 21×12 的小棋盘上也能看出
 * 是一条连续的曲线，而不是一堆点或者一个方框。
 */
function drawArcs(canvas) {
  for (const circle of R.CIRCLES) {
    const pts = R.loopArcPoints(circle, 400);
    const style = circle.inner ? S.inner : S.outer;
    let lastX = -1, lastY = -1;
    for (let i = 0; i < pts.length; i++) {
      const x = Math.round(ORIGIN_X + pts[i].x * STEP_X);
      const y = Math.round(ORIGIN_Y + pts[i].y * STEP_Y);
      if (x === lastX && y === lastY) continue;
      lastX = x;
      lastY = y;
      const back = pts[Math.max(0, i - 1)];
      const fwd = pts[Math.min(pts.length - 1, i + 1)];
      canvas.put(x, y, tangentGlyph(fwd.x - back.x, fwd.y - back.y), style, P.arc);
    }
  }
}

/**
 * 三种线的画法（与网页版 drawGridLines 的叠放次序一致）：
 * 第 0、5 行/列是最外侧的线，没有环，用暗棕色；
 * 第 1、4 行/列属于内侧回路（青色）；第 2、3 行/列属于外侧回路（绿色）。
 * 交叉点取两条线里优先级高的那个颜色，因此回路一眼就能看出来。
 */
function drawLines(canvas) {
  const order = [0, SIZE - 1].concat(R.INNER_LINES, R.OUTER_LINES);
  for (const index of order) {
    const y = ORIGIN_Y + index * STEP_Y;
    const style = lineStyle(index);
    const prio = linePriority(index);
    for (let c = 0; c < SIZE; c++) {
      const x = ORIGIN_X + c * STEP_X;
      canvas.put(x, y, G.cross, style, prio);
      if (c < SIZE - 1) canvas.put(x + 1, y, G.hLine, style, prio);
    }
  }
  // 竖线只由交叉点组成（纵向一格就是一行），后画即可覆盖优先级更低的行线
  for (const index of order) {
    const x = ORIGIN_X + index * STEP_X;
    const style = lineStyle(index);
    const prio = linePriority(index);
    for (let r = 0; r < SIZE; r++) {
      canvas.put(x, ORIGIN_Y + r * STEP_Y, G.cross, style, prio);
    }
  }
}

/** 八个角环在棋盘上的切点：棋子走到这里就能拐进环里吃子 */
function drawLoopMarks(canvas, board) {
  for (let cell = 0; cell < R.CELLS; cell++) {
    if (R.LOOP_PARTNER[cell] < 0) continue;
    if (board[cell] !== R.EMPTY) continue;
    canvas.put(cellX(cell), cellY(cell), G.loop, S.loop, P.loop);
  }
}

/**
 * 把 rules 给出的多段线（格为单位，圆弧处带小数）画到棋盘上。
 * 绕行路线一律用 trail 字形串成一串珠子：它要和棋盘线、角环都区分得开，
 * 光靠颜色不够，所以形状也换掉。
 */
function drawPath(canvas, poly, style, prio) {
  if (!poly) return;
  for (let i = 0; i < poly.length - 1; i++) {
    const a = poly[i], b = poly[i + 1];
    canvas.seg(
      Math.round(ORIGIN_X + a.x * STEP_X),
      Math.round(ORIGIN_Y + a.y * STEP_Y),
      Math.round(ORIGIN_X + b.x * STEP_X),
      Math.round(ORIGIN_Y + b.y * STEP_Y),
      style, prio, G.trail
    );
  }
}

function drawHints(canvas, hints) {
  for (const hint of hints) {
    if (hint.capture) continue;                 // 吃子目标靠棋子的红底表示
    canvas.put(cellX(hint.to), cellY(hint.to), G.dot, S.hint, P.hint);
  }
}

function drawPieces(canvas, ctx) {
  const state = ctx.state;
  if (!state) return;
  const captureTo = new Set();
  for (const hint of ctx.hints) if (hint.capture) captureTo.add(hint.to);
  const lastFrom = state.lastMove == null ? -1 : R.moveFrom(state.lastMove);
  const lastTo = state.lastMove == null ? -1 : R.moveTo(state.lastMove);

  for (let cell = 0; cell < R.CELLS; cell++) {
    const piece = state.board[cell];
    if (piece === R.EMPTY) continue;
    let style = piece === R.BLACK ? S.black : S.red;
    if (captureTo.has(cell)) style = S.captureBg + style;
    if (cell === ctx.selected || cell === lastTo) style = S.underline + style;
    if (cell === lastFrom) style = S.dim + style;
    canvas.put(cellX(cell), cellY(cell), piece === R.BLACK ? G.black : G.red, style, P.piece);
  }
}

function drawCursor(canvas, ctx) {
  const x = cellX(R.idx(ctx.cursor.r, ctx.cursor.c));
  const y = cellY(R.idx(ctx.cursor.r, ctx.cursor.c));
  if (S.enabled) {
    // 反色：保留该格原有的前景色，只把底色调过来
    canvas.put(x, y, canvas.glyphAt(x, y), canvas.styleAt(x, y) + S.inverse, P.cursor);
  } else {
    // 没有 ANSI 时就画一行插入符指向光标所在的列
    canvas.put(x, BOARD_H - 1, G.caret, '', P.cursor);
  }
}

function renderBoardLines(ctx) {
  const canvas = createCanvas(BOARD_W, BOARD_H, S);
  const board = ctx.state ? ctx.state.board : new Array(R.CELLS).fill(R.EMPTY);

  drawArcs(canvas);
  drawLines(canvas);
  drawLoopMarks(canvas, board);

  // 选中棋子的全部吃子路线；光标停在哪条上，哪条就画成高亮
  for (const hint of ctx.hints) {
    if (!hint.capture || !hint.path) continue;
    const active = hint.path === ctx.hoverPath;
    drawPath(canvas, hint.path, active ? S.trail : S.trailDim,
      active ? P.pathActive : P.path);
  }
  // 没有选中棋子时，把最近一次吃子的绕行路线淡淡地留着
  if (ctx.selected < 0 && ctx.state && ctx.state.lastPath) {
    drawPath(canvas, ctx.state.lastPath, S.trailDim, P.path);
  }

  drawHints(canvas, ctx.hints);
  drawPieces(canvas, ctx);
  drawCursor(canvas, ctx);
  return canvas.toLines();
}

// ============================================================ 文案
//
// 界面文字一律出自 js/i18n.js，这里只留语言无关的东西：数字、符号、字形。
// 当前语言放在 app.locale，L 键改的就是它，改完重画即可。

const SPINNER = OPTS.ascii
  ? ['|', '/', '-', '\\']
  : ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

const SIDE_MARK = { 1: G.black, 2: G.red };

/** 取词的小包装：app.locale 是此刻的界面语言 */
function tr(key, params) {
  return I18N.t(app.locale, key, params);
}

function sideName(side, short) {
  return I18N.sideName(app.locale, side, short);
}

function levelName(key) {
  return I18N.levelName(app.locale, key);
}

/** 后端还没算过任何一手时 lastScore 是 null，别把它当成 0 来排版 */
function formatScore(score) {
  const WIN = 100000;
  if (score >= WIN - 1000) return tr('stat.winning');
  if (score <= -(WIN - 1000)) return tr('stat.losing');
  return (score >= 0 ? '+' : '') + (score / 100).toFixed(2);
}

function formatNumber(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 把多段线里落在交叉点上的部分列成 a2→a3→…，拐弯处标一个 ↻ */
function describePath(poly) {
  if (!poly) return '';
  const parts = [];
  for (const p of poly) {
    if (Number.isInteger(p.x) && Number.isInteger(p.y)) {
      const name = cellName(R.idx(p.y, p.x));
      if (parts[parts.length - 1] !== name) parts.push(name);
    } else if (parts[parts.length - 1] !== '↻') {
      parts.push('↻');
    }
  }
  return parts.join(' ');
}

// ============================================================ 面板

const PANEL_W = 40;
// 面板的标签列按「英文标签 + 一格」取宽：英文比中文长得多
// （最长的是 Difficulty = 10 格，中文只有 4 格），不留够整个面板都会错位。
const LABEL_W = 11;

function field(label, value, width) {
  return padTo(S.dimText + label + S.reset, LABEL_W) +
    clipTo(value, Math.max(4, width - LABEL_W));
}

function buildPanelLines(ctx, width) {
  const out = [];
  const push = str => out.push(padTo(str, width));
  const pushRaw = str => out.push(clipTo(str, width));

  push(S.title + tr('tui.title') + S.reset);
  push(S.dimText + repeatTo('─', width) + S.reset);

  const state = ctx.state;
  if (!state) {
    pushRaw(S.dimText + tr('tui.loading') + S.reset);
    return out;
  }

  pushRaw(field(tr('tui.youPlay'), S.text + sideName(state.humanSide) + ' ' +
    SIDE_MARK[state.humanSide] + S.reset, width));

  let turn;
  if (state.status === 'over') turn = S.warn + tr('status.gameOver') + S.reset;
  else if (state.thinking) turn = S.accent + tr('tui.thinking', { side: sideName(state.side) }) + S.reset;
  else if (state.side === state.humanSide) turn = S.ok + tr('tui.yourTurn', { side: sideName(state.side) }) + S.reset;
  else turn = S.text + tr('tui.aiTurn', { side: sideName(state.side) }) + S.reset;
  pushRaw(field(tr('tui.turn'), turn, width));

  pushRaw(field(tr('tui.level'), S.text + levelName(state.levelKey) + S.reset + S.dimText +
    ' · ' + tr('level.depthTag', { depth: state.levelDepth }) + S.reset, width));
  pushRaw(field(tr('tui.pieces'), S.black + G.black + ' ' + state.counts.black + S.reset +
    '   ' + S.red + G.red + ' ' + state.counts.red + S.reset, width));
  // 还没走过任何一手就谈不上「最近一手」的评分；newGame 不会清掉上一局的
  // lastScore，所以这里看的是「有没有着法记录」而不是单纯看字段是不是数字
  const hasScore = typeof state.lastScore === 'number' && state.moves.length > 0;
  // 中文的括号是全角，紧贴数字就行；英文的 ( 前留一格才不挤
  const scoreFrom = tr('tui.scoreFromAI');
  pushRaw(field(tr('tui.score'), hasScore
    ? S.text + formatScore(state.lastScore) + S.reset + S.dimText +
      (charWidth(scoreFrom.codePointAt(0)) === 2 ? '' : ' ') + scoreFrom + S.reset
    : S.dimText + '—' + S.reset, width));
  pushRaw(field(tr('tui.cursor'), S.accent + cellName(R.idx(ctx.cursor.r, ctx.cursor.c)) + S.reset, width));

  // ---- AI 思考进度（progress 还没到之前只报「准备中」，不硬凑 0）。
  // 英文的进度串比中文长，按面板宽度折行，两种语言都不会被切掉。
  if (state.thinking) {
    const p = state.progress;
    const total = Math.max(1, state.levelDepth);
    const done = p ? Math.min(total, p.depth || 0) : 0;
    const cells = 10;
    const filled = Math.round(cells * done / total);
    const bar = S.ok + '█'.repeat(filled) + S.reset + S.dimText + '░'.repeat(cells - filled) + S.reset;
    out.push('');
    pushRaw(S.accent + tr('tui.thinking', { side: sideName(state.side) }) + S.reset);
    pushRaw(' ' + bar);
    const detail = p
      ? tr('tui.progress', {
          depth: done,
          total: state.levelDepth,
          nodes: formatNumber(p.nodes),
          seconds: (p.elapsedMs / 1000).toFixed(2),
          current: p.currentDepth || 0
        })
      : tr('tui.preparing');
    for (const line of wrapText(detail, Math.max(8, width - 1))) {
      pushRaw(S.dimText + ' ' + line + S.reset);
    }
  }

  // ---- 选中棋子与提示
  if (ctx.selected >= 0 && ctx.hints.length) {
    out.push('');
    pushRaw(S.accent + tr('tui.selected', { cell: cellName(ctx.selected), n: ctx.hints.length }) + S.reset);
    let shown = 0;
    for (const hint of ctx.hints) {
      if (shown >= 8) { pushRaw(S.dimText + '  …' + S.reset); break; }
      const active = ctx.hoverPath && hint.path === ctx.hoverPath;
      const mark = hint.capture ? S.red + ' ' + tr('tui.captureMark') + S.reset : '';
      pushRaw((active ? S.trail : S.dimText) + '  ▸ ' + cellName(hint.to) + S.reset + mark);
      shown++;
    }
    if (ctx.hoverPath) {
      pushRaw(S.trail + clipTo(tr('tui.hoverPath', { path: describePath(ctx.hoverPath) }), width) + S.reset);
      pushRaw(S.dimText + tr('tui.captureTrail') + S.reset);
    }
  }

  // ---- 终局：后端只给结构化的 result，句子由 i18n 按当前语言拼
  if (state.status === 'over' && state.result) {
    out.push('');
    pushRaw(S.warn + tr('status.gameOver') + S.reset);
    for (const line of wrapText(I18N.formatResult(app.locale, state.result), width - 2)) {
      pushRaw(' ' + S.text + line + S.reset);
    }
  }

  return out;
}

/**
 * 按可见宽度折行（中文、全角标点算两格）。
 * 英文句子比中文长，硬断会把单词劈成两半，所以行内还有空格时
 * 优先在最后一个空格处断开；中文没有空格，退回逐字折行。
 */
function wrapText(text, width) {
  const lines = [];
  let line = [];
  let used = 0;
  for (const ch of text) {
    const w = charWidth(ch.codePointAt(0));
    if (used + w > width && line.length) {
      let cut = -1;
      for (let i = line.length - 1; i > 0; i--) {
        if (line[i] === ' ') { cut = i; break; }
      }
      if (cut > 0) {
        const rest = line.slice(cut + 1);
        lines.push(line.slice(0, cut).join(''));
        line = rest;
        used = rest.reduce((n, c) => n + charWidth(c.codePointAt(0)), 0);
      } else {
        lines.push(line.join(''));
        line = [];
        used = 0;
      }
    }
    line.push(ch);
    used += w;
  }
  if (line.length) lines.push(line.join(''));
  return lines;
}

function buildLogLines(ctx, width, maxLines) {
  const lines = [];
  if (maxLines <= 0) return lines;
  const moves = (ctx.state && ctx.state.moves) || [];
  lines.push(S.dimText + tr('tui.moveLog', { n: moves.length }) + S.reset);

  const body = maxLines - 1;
  if (body <= 0) return lines;
  if (moves.length === 0) {
    lines.push(S.dimText + '  ' + tr('tui.noMoves') + S.reset);
    return lines;
  }
  const start = Math.max(0, moves.length - body);
  for (let i = start; i < moves.length; i++) {
    const no = String(i + 1).padStart(3, ' ');
    const latest = i === moves.length - 1;
    // 后端的着法是结构化的 { side, from, to, capture }，由 i18n 渲染成当前语言的文字
    const text = I18N.formatMove(app.locale, moves[i]);
    lines.push(S.dimText + no + '.' + S.reset + ' ' +
      (latest ? S.accent + text : S.text + text) + S.reset);
  }
  return lines.map(l => clipTo(l, width));
}

function buildHeader(ctx, width) {
  const left = S.title + tr('tui.title') + S.reset;
  const dot = ctx.connected ? S.ok + '●' + S.reset : S.err + '●' + S.reset;
  const word = ctx.connected ? tr('tui.connected') : tr('tui.disconnected');
  const right = dot + ' ' + (ctx.connected ? S.dimText : S.err) + word + ' ' +
    S.dimText + ctx.base + S.reset;
  const room = width - 2 - visibleWidth(left);
  if (room <= visibleWidth(right)) {
    // 地址太长就把地址省掉，至少留个连没连上的标记
    const brief = dot + ' ' + (ctx.connected ? S.dimText : S.err) + word + S.reset;
    if (room <= visibleWidth(brief)) return ' ' + clipTo(left, width - 2);
    return ' ' + left + ' '.repeat(room - visibleWidth(brief)) + brief;
  }
  return ' ' + left + ' '.repeat(room - visibleWidth(right)) + right;
}

function buildStatusLine(ctx, width) {
  const state = ctx.state;
  if (ctx.banner) return ' ' + clipTo(S.err + '✖ ' + ctx.banner + S.reset, width - 2);
  if (!ctx.connected && ctx.connError) {
    return ' ' + clipTo(S.err + '✖ ' + ctx.connError + S.reset, width - 2);
  }
  if (!state) return ' ' + S.dimText + tr('tui.loading') + S.reset;

  if (state.status === 'over') {
    return ' ' + clipTo(S.warn + tr('status.gameOver') + ' ' +
      I18N.formatResult(app.locale, state.result) + S.reset, width - 2);
  }
  if (state.thinking) {
    const p = state.progress;
    const spin = SPINNER[ctx.spinner % SPINNER.length];
    const detail = p
      ? tr('tui.progress', {
          depth: Math.min(state.levelDepth, p.depth || 0),
          total: state.levelDepth,
          nodes: formatNumber(p.nodes),
          seconds: (p.elapsedMs / 1000).toFixed(2),
          current: p.currentDepth || 0
        })
      : tr('stat.preparing');
    return ' ' + clipTo(S.accent + spin + ' ' +
      tr('status.thinking', { side: sideName(state.side), level: levelName(state.levelKey) }) +
      S.dimText + '  ' + detail + S.reset, width - 2);
  }
  if (state.side === state.humanSide) {
    return ' ' + clipTo(S.ok + '● ' + tr('tui.yourTurn', { side: sideName(state.side) }) + S.reset +
      S.dimText + '  ' + tr('tui.yourTurnHint') + S.reset, width - 2);
  }
  return ' ' + clipTo(S.text + '● ' + tr('tui.aiTurn', { side: sideName(state.side) }) + S.reset, width - 2);
}

function buildHelpLine(ctx, width) {
  const text = tr('tui.hintBar') + ' · L ' + tr('tui.help.lang');
  return ' ' + S.dimText + clipTo(text, width - 2) + S.reset;
}

// ============================================================ 整屏组装

const MIN_COLS = 34;
const MIN_ROWS = 16;

function buildSmallScreen(cols, rows) {
  const out = [''];
  const push = (style, text) => {
    for (const line of wrapText(text, Math.max(8, cols - 2))) out.push(' ' + style + line + S.reset);
  };
  push(S.warn, tr('tui.tooSmall', { cols, rows, needCols: MIN_COLS, needRows: MIN_ROWS }));
  push(S.dimText, tr('tui.tooSmallHint'));
  return out;
}

// 帮助浮层的标签列：英文标签里最长的 "Cancel selection" 有 16 格，
// 中文最长只有 9 格，所以按英文留。
const HELP_LABEL_W = 17;

function buildHelpOverlay(ctx, cols, rows) {
  const lv = key => levelName(key);
  // 图例里的「样例」用颜色区分，标签本身就是棋盘上的那个字形
  const rowsSpec = [
    [S.accent + tr('tui.help.move') + S.reset, tr('tui.help.moveKeys')],
    [S.accent + tr('tui.help.confirm') + S.reset, tr('tui.help.confirmKeys')],
    [S.accent + tr('tui.help.esc') + S.reset, 'Esc'],
    [S.accent + tr('tui.help.new') + S.reset, 'n'],
    [S.accent + tr('tui.help.undo') + S.reset, tr('tui.help.undoKeys')],
    [S.accent + tr('tui.help.side') + S.reset, tr('tui.help.sideKeys')],
    [S.accent + tr('tui.help.agree') + S.reset, 'a'],
    [S.accent + tr('tui.help.level') + S.reset,
      tr('tui.help.levelKeys', { l1: lv(1), l2: lv(2), l3: lv(3), l4: lv(4) })],
    [S.accent + tr('tui.help.lang') + S.reset, tr('tui.help.langKeys')],
    [S.accent + tr('tui.help.help') + S.reset, '?'],
    [S.accent + tr('tui.help.quit') + S.reset, tr('tui.help.quitKeys')],
    ['', ''],
    [S.accent + tr('tui.help.legend') + S.reset, ''],
    [S.loop + G.loop + S.reset + ' ' + S.text + tr('tui.help.loop') + S.reset, tr('tui.help.loopText')],
    [S.hint + G.dot + S.reset + ' ' + S.text + tr('tui.help.dot') + S.reset, tr('tui.help.dotText')],
    [S.trail + G.trail + S.reset, tr('tui.help.trail')],
    [S.captureBg + S.red + G.red + S.reset, tr('tui.help.enemy')],
    [S.accent + tr('tui.help.play') + S.reset, tr('tui.help.playText1')],
    ['', tr('tui.help.playText2')],
    ['', tr('tui.help.playText3')],
    ['', tr('tui.help.playText4')]
  ];

  const lines = [];
  lines.push(' ' + S.title + tr('tui.title') + ' · ' + tr('tui.helpTitle') + S.reset);
  lines.push(' ' + S.dimText + repeatTo('─', Math.min(cols - 4, 66)) + S.reset);
  for (const [label, text] of rowsSpec) {
    if (!label && !text) { lines.push(''); continue; }
    const body = text ? clipTo(S.text + text + S.reset, cols - HELP_LABEL_W - 4) : '';
    lines.push(' ' + padTo(label, HELP_LABEL_W) + ' ' + body);
  }
  lines.push(' ' + S.dimText + tr('tui.helpAny') + S.reset);

  // 垂直居中，且不超过屏幕高度
  const body = lines.slice(0, Math.max(1, rows));
  const top = Math.max(0, Math.floor((rows - body.length) / 2) - 1);
  const out = [];
  for (let i = 0; i < top; i++) out.push('');
  return out.concat(body);
}

function buildFrame(ctx) {
  const { cols, rows } = ctx.size;
  if (ctx.showHelp) {
    const lines = buildHelpOverlay(ctx, cols, rows);
    return lines.slice(0, rows);
  }
  if (cols < MIN_COLS || rows < MIN_ROWS) return buildSmallScreen(cols, rows);

  const header = buildHeader(ctx, cols);
  const status = buildStatusLine(ctx, cols);
  const help = buildHelpLine(ctx, cols);
  const sideBySide = cols >= BOARD_W + PANEL_W + 4;
  const out = [header];

  if (sideBySide) {
    const panel = buildPanelLines(ctx, PANEL_W);
    const bodyH = Math.min(Math.max(BOARD_H, panel.length), Math.max(BOARD_H, rows - 5));
    const logLines = Math.max(0, rows - 3 - bodyH - 1);
    const board = renderBoardLines(ctx);
    for (let i = 0; i < bodyH; i++) {
      const left = ' ' + (board[i] || ' '.repeat(BOARD_W)) + '  ';
      const right = panel[i] || '';
      out.push(clipTo(left + right, cols));
    }
    if (logLines > 0) {
      out.push('');
      for (const line of buildLogLines(ctx, cols - 2, logLines)) out.push(' ' + line);
    }
  } else {
    // 竖排：棋盘在上，面板与着法记录瓜分剩下的高度，不够就先饿着着法记录
    const budget = Math.max(0, rows - BOARD_H - 3);
    const panel = buildPanelLines(ctx, cols - 2);
    const panelBudget = Math.max(0, Math.min(panel.length, budget - 7));
    const withLog = budget - panelBudget >= 2;
    const logLines = withLog ? budget - panelBudget - 1 : 0;
    for (const line of renderBoardLines(ctx)) out.push(' ' + line);
    for (let i = 0; i < panelBudget; i++) out.push(' ' + panel[i]);
    if (logLines > 0) {
      out.push('');
      for (const line of buildLogLines(ctx, cols - 2, logLines)) out.push(' ' + line);
    }
  }

  out.push(status);
  out.push(help);
  return out.slice(0, rows);
}

// ============================================================ HTTP 客户端
//
// 每步棋都要问后端，所以这里只用最小的 http.request 封装。
// agent: false 让连接用完即关，进程才能干净地退出。

function apiRequest(method, url, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch (e) {
      reject(new Error(tr('tui.badUrl', { url })));
      return;
    }
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const headers = { Accept: 'application/json', Connection: 'close' };
    if (payload) {
      headers['Content-Type'] = 'application/json; charset=utf-8';
      headers['Content-Length'] = payload.length;
    }
    const req = http.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || 80,
      path: target.pathname + target.search,
      method,
      headers,
      agent: false
    }, res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        raw += chunk;
        if (raw.length > (4 << 20)) req.destroy(new Error(tr('tui.responseTooLarge')));
      });
      res.on('end', () => {
        let data = null;
        try { data = raw ? JSON.parse(raw) : null; } catch (e) { /* 交给调用方判断 */ }
        resolve({ status: res.statusCode, data });
      });
    });
    req.on('error', err => {
      if (err.code === 'ECONNREFUSED') reject(new Error(tr('tui.refused')));
      else reject(err);
    });
    req.setTimeout(timeoutMs || 5000, () => req.destroy(new Error(tr('tui.timeout'))));
    if (payload) req.write(payload);
    req.end();
  });
}

// ============================================================ 应用状态

const app = {
  state: null,          // 后端给的最新快照
  base: OPTS.server,
  locale: OPTS.lang,    // 界面语言：--lang 给的，之后由 L 键切换
  connected: false,
  connError: '',
  banner: '',
  cursor: { r: 0, c: 0 },
  selected: -1,
  hints: [],
  hoverPath: null,
  showHelp: false,
  spinner: 0,
  dirty: true,
  size: { cols: 80, rows: 24 }
};

let bannerTimer = null;

function setBanner(text) {
  app.banner = text || '';
  app.dirty = true;
  clearTimeout(bannerTimer);
  if (text) bannerTimer = setTimeout(() => { app.banner = ''; app.dirty = true; render(); }, 5000);
}

function clearBanner() {
  app.banner = '';
  clearTimeout(bannerTimer);
}

/** 对后端的每次调用都走这里，顺带维护「连上了没有」 */
function callApi(method, path, body, timeoutMs) {
  return apiRequest(method, app.base + path, body, timeoutMs).then(res => {
    app.connected = true;
    app.connError = '';
    return res;
  });
}

/**
 * 后端失败时给的是 { ok:false, error:{ code, params }, message }。
 * 优先自己按当前语言渲染错误码；message 是服务端语言渲染好的，只在没有错误码时兜底。
 */
function apiErrorText(data, fallbackKey) {
  const err = data && data.error;
  if (err && typeof err === 'object' && err.code) {
    const text = I18N.t(app.locale, err.code, err.params);
    if (text !== err.code) return text;
  }
  if (typeof err === 'string' && err) return err;
  if (data && typeof data.message === 'string' && data.message) return data.message;
  return tr(fallbackKey || 'err.actionFailed');
}

/** L 键：在 i18n 给出的语言列表里循环切换 */
function nextLocale() {
  const index = I18N.LOCALES.findIndex(l => l.code === app.locale);
  return I18N.LOCALES[(index + 1) % I18N.LOCALES.length].code;
}

// ============================================================ 终端控制

let restored = false;

function restoreTerminal() {
  if (restored) return;
  restored = true;
  try {
    if (process.stdin.isTTY && process.stdin.setRawMode) process.stdin.setRawMode(false);
  } catch (e) { /* 忽略：已经在退出路上了 */ }
  if (INTERACTIVE) process.stdout.write('\x1b[0m\x1b[?25h\x1b[?1049l');
}

function enterTerminal() {
  if (!INTERACTIVE) return;
  process.stdout.write('\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H');
}

let framesWritten = 0;

/*
 * --plain 模式下棋盘字形已经换成 ASCII 了，但正文里还夹着几个符号：
 * 标题分隔用的 ·、连接状态的 ●、着法里的 →、英文里的 ’、太窄提示里的 ×，
 * 帮助里的 ↑↓←→。终端不认 Unicode 时这些同样是乱码源，一并换成 ASCII。
 * 换完可能变宽（→ 变成 ->），所以换完再按屏幕宽度裁一次。
 */
const PLAIN_ASCII = {
  '─': '-', '·': '|', '●': '*', '→': '->', '’': "'", '×': 'x',
  '↑': '^', '↓': 'v', '←': '<', '“': '"', '”': '"', '—': '-', '–': '-'
};
const PLAIN_NEEDS_MAP = new RegExp('[' + Object.keys(PLAIN_ASCII).join('') + ']', 'g');

// 帮助里「切换语言」那行要同时写出两种语言的名字，本来是唯一的汉字例外；
// ASCII 模式下改用语言代码，这样 --plain --lang en 的输出就是纯 ASCII。
const PLAIN_PHRASES = [['中文', 'zh']];

function toPlainAscii(line, cols) {
  let text = line;
  for (const [from, to] of PLAIN_PHRASES) text = text.split(from).join(to);
  text = text.replace(PLAIN_NEEDS_MAP, ch => PLAIN_ASCII[ch]);
  return clipTo(text, cols);
}

function render() {
  if (!app.dirty) return;
  app.dirty = false;
  const lines = buildFrame(app);
  if (OPTS.ascii) {
    for (let i = 0; i < lines.length; i++) lines[i] = toPlainAscii(lines[i], app.size.cols);
  }
  const text = lines.join('\n');
  if (INTERACTIVE) {
    process.stdout.write('\x1b[H' + text + '\x1b[0m\x1b[J');
    return;
  }
  // 没有备用屏幕时每帧依次往下写，分隔一下才看得出边界
  const sep = framesWritten > 0 ? '\n' + '-'.repeat(Math.max(8, app.size.cols - 1)) + '\n' : '';
  framesWritten++;
  process.stdout.write(sep + text + '\n');
}

function requestRender() {
  app.dirty = true;
}

// ============================================================ 输入

const queue = [];
let busy = false;
let inputEnded = false;
let quitting = false;
let quitCode = 0;

function pushKey(key) {
  if (quitting) return;
  queue.push(key);
  drainQueue();
}

function drainQueue() {
  if (busy || quitting) return;
  const key = queue.shift();
  if (key === undefined) {
    if (inputEnded) shutdown(quitCode);
    return;
  }
  busy = true;
  Promise.resolve()
    .then(() => handleKey(key))
    .catch(err => setBanner(String(err && err.message || err)))
    .then(() => {
      busy = false;
      render();
      drainQueue();
    });
}

function createKeyReader(onKey) {
  let buf = '';
  let escTimer = null;

  const SEQS = {
    '\x1b[A': 'up', '\x1b[B': 'down', '\x1b[C': 'right', '\x1b[D': 'left',
    '\x1bOA': 'up', '\x1bOB': 'down', '\x1bOC': 'right', '\x1bOD': 'left',
    '\x1b[1~': 'home', '\x1b[4~': 'end'
  };

  function classify(ch) {
    if (ch === '\r' || ch === '\n') return 'enter';
    if (ch === ' ') return 'space';
    if (ch === '\x03') return 'ctrl-c';
    if (ch === '\x7f' || ch === '\b') return 'backspace';
    if (ch === '\t') return 'tab';
    // 大写 L 单独留给「切换语言」：小写 l 已经是光标右移
    if (ch.length === 1) return ch === 'L' ? 'lang' : ch.toLowerCase();
    return 'unknown';
  }

  function drain() {
    while (buf.length > 0) {
      if (buf[0] === '\x1b') {
        const m = /^\x1b\[[0-9;]*[A-Za-z~]/.exec(buf) || /^\x1bO[A-Za-z]/.exec(buf);
        if (m) {
          const key = SEQS[m[0]];
          buf = buf.slice(m[0].length);
          if (key) onKey(key);
          continue;
        }
        if (buf.length === 1) {
          // 可能还差几个字节才凑成方向键，稍等一下再说
          if (!escTimer) {
            escTimer = setTimeout(() => {
              escTimer = null;
              if (buf === '\x1b') { buf = ''; onKey('esc'); }
              else drain();
            }, 30);
          }
          return;
        }
        buf = buf.slice(1);
        onKey('esc');
        continue;
      }
      const cp = buf.codePointAt(0);
      const ch = String.fromCodePoint(cp);
      buf = buf.slice(ch.length);
      onKey(classify(ch));
    }
  }

  return {
    feed(chunk) { buf += chunk; drain(); },
    /** 退出前把还握在手里的按键吐出来（例如管道里最后一个不带换行的字符） */
    flush() { if (buf === '\x1b') { buf = ''; onKey('esc'); } }
  };
}

// ============================================================ 对局动作

function cellAtCursor() {
  return R.idx(app.cursor.r, app.cursor.c);
}

function moveCursor(dr, dc) {
  app.cursor.r = Math.min(SIZE - 1, Math.max(0, app.cursor.r + dr));
  app.cursor.c = Math.min(SIZE - 1, Math.max(0, app.cursor.c + dc));
  updateHoverPath();
  requestRender();
}

function updateHoverPath() {
  app.hoverPath = null;
  if (app.selected < 0) return;
  const cell = cellAtCursor();
  if (cell === app.selected) return;
  for (const hint of app.hints) {
    if (hint.to === cell && hint.capture) { app.hoverPath = hint.path; return; }
  }
}

function clearSelection() {
  app.selected = -1;
  app.hints = [];
  app.hoverPath = null;
  requestRender();
}

function confirm() {
  const s = app.state;
  if (!s) return Promise.resolve();
  if (s.status !== 'playing') { setBanner(tr('tui.gameOver')); return Promise.resolve(); }
  if (s.thinking || s.side !== s.humanSide) { setBanner(tr('tui.waitAI')); return Promise.resolve(); }

  const cell = cellAtCursor();
  if (app.selected >= 0) {
    for (const hint of app.hints) {
      if (hint.to === cell) return playMove(hint.move);
    }
  }
  if (s.board[cell] === s.humanSide) return select(cell);
  clearSelection();
  return Promise.resolve();
}

function select(cell) {
  app.selected = cell;
  app.hints = [];
  app.hoverPath = null;
  requestRender();
  render();
  return callApi('GET', '/api/hints?cell=' + cell, undefined, 4000)
    .then(res => {
      if (app.selected !== cell) return;          // 期间光标又跑去别处了
      if (res.status !== 200 || !res.data || res.data.ok === false) {
        throw new Error(apiErrorText(res.data, 'tui.hintsFailed'));
      }
      app.hints = res.data.hints || [];
      updateHoverPath();
      requestRender();
    });
}

function playMove(move) {
  return callApi('POST', '/api/move', { move }, 8000).then(res => {
    if (res.data && res.data.state) applyState(res.data.state);
    if (res.status !== 200 || (res.data && res.data.ok === false)) {
      setBanner(apiErrorText(res.data, 'tui.moveFailed'));
    } else {
      clearBanner();
    }
    clearSelection();
    requestRender();
  }).catch(err => {
    setBanner(tr('conn.lost', { error: err.message }));
    requestRender();
  });
}

/** 所有「一个按钮搞定」的接口都走这里；failKey 是没有错误码时的兜底文案 */
function postAction(path, body, failKey) {
  clearBanner();
  return callApi('POST', path, body || {}, 8000).then(res => {
    if (res.data && res.data.state) applyState(res.data.state);
    if (res.status !== 200 || (res.data && res.data.ok === false)) {
      setBanner(apiErrorText(res.data, failKey));
    }
    requestRender();
  }).catch(err => {
    setBanner(tr('conn.lost', { error: err.message }));
    requestRender();
  });
}

async function handleKey(key) {
  if (key === 'ctrl-c') { shutdown(0); return; }

  if (app.showHelp) {
    if (key === 'ctrl-c') { shutdown(0); return; }
    app.showHelp = false;                 // 帮助页上按任意键回到棋盘
    requestRender();
    return;
  }

  switch (key) {
    case 'up': case 'w': case 'k': moveCursor(-1, 0); return;
    case 'down': case 's': case 'j': moveCursor(1, 0); return;
    case 'left': case 'h': moveCursor(0, -1); return;   // 注意：a 留给了「协商终局」
    case 'right': case 'd': case 'l': moveCursor(0, 1); return;
    case 'enter': case 'space': return confirm();
    case 'esc': clearSelection(); return;
    case 'n': return postAction('/api/new', {}, 'tui.newFailed');
    case 'u': return postAction('/api/undo', {}, 'tui.undoFailed');
    case 'c': return postAction('/api/side', {
      side: app.state && app.state.humanSide === R.BLACK ? R.RED : R.BLACK
    }, 'tui.sideFailed');
    case 'a': return postAction('/api/agree', {}, 'tui.agreeFailed');
    case '1': case '2': case '3': case '4':
      return postAction('/api/level', { level: Number(key) - 1 }, 'tui.levelFailed');
    case 'lang': app.locale = nextLocale(); requestRender(); return;
    case '?': app.showHelp = true; requestRender(); return;
    case 'q': shutdown(0); return;
    default: return;
  }
}

// ============================================================ 状态同步

/** 把后端快照装进来；只有真的变了才要求重画 */
function applyState(next) {
  const prev = app.state;
  app.state = next;
  if (prev && next.revision === prev.revision && next.position === prev.position) return false;

  if (!prev || next.position !== prev.position) {
    app.selected = -1;
    app.hints = [];
    app.hoverPath = null;
    // 轮到自己的时候，别把光标撂在对方的棋子上
    if (next.status === 'playing' && next.side === next.humanSide &&
        next.board[cellAtCursor()] !== next.humanSide) {
      initCursor(next);
    }
  }
  if (!prev || next.humanSide !== prev.humanSide) initCursor(next);
  app.spinner++;                       // 只在真的要重画时才转一下，省得白刷屏
  requestRender();
  return true;
}

/** 把光标放到自己第一枚「现在就能走」的棋子上，省得玩家四处找 */
function initCursor(state) {
  const human = state.humanSide;
  const place = cell => {
    app.cursor.r = R.rowOf(cell);
    app.cursor.c = R.colOf(cell);
  };
  if (state.side === human) {
    for (const move of state.legal || []) {
      const from = R.moveFrom(move);
      if (state.board[from] === human) { place(from); return; }
    }
  }
  for (let cell = 0; cell < R.CELLS; cell++) {
    if (state.board[cell] === human) { place(cell); return; }
  }
  place(0);
}

let pollTimer = null;

function pollDelay() {
  const s = app.state;
  return s && s.thinking ? 120 : 400;   // AI 思考时盯紧一点，平时松一些
}

function poll() {
  if (quitting) return;
  callApi('GET', '/api/state', undefined, 4000)
    .then(res => {
      if (!res.data || !res.data.state) throw new Error(tr('conn.badState'));
      app.connected = true;
      app.connError = '';
      applyState(res.data.state);
    })
    .catch(err => {
      app.connected = false;
      app.connError = tr('conn.lost', { error: err.message });
      requestRender();
    })
    .then(() => {
      render();
      if (!quitting) pollTimer = setTimeout(poll, pollDelay());
    });
}

// ============================================================ 退出

function shutdown(code) {
  if (quitting) return;
  quitting = true;
  quitCode = code || 0;
  clearTimeout(pollTimer);
  clearTimeout(bannerTimer);
  render();
  restoreTerminal();
  try { process.stdin.pause(); } catch (e) { /* 忽略 */ }
  if (typeof process.stdin.unref === 'function') process.stdin.unref();
  process.exitCode = quitCode;
  // 兜底：万一还有句柄拽着事件循环，也能干净退出
  setTimeout(() => process.exit(quitCode), 250).unref();
}

// ============================================================ 启动

function readSize() {
  // 输出不是终端时（重定向到文件、管道、测试）拿不到真实尺寸，
  // 这时按 COLUMNS / LINES 环境变量来，两者都没有就按 80×24。
  const envCols = Number(process.env.COLUMNS);
  const envRows = Number(process.env.LINES);
  app.size = {
    cols: process.stdout.columns || (envCols > 0 ? envCols : 80),
    rows: process.stdout.rows || (envRows > 0 ? envRows : 24)
  };
}

function startInput() {
  const reader = createKeyReader(pushKey);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => reader.feed(chunk));
  process.stdin.on('end', () => {
    reader.flush();
    inputEnded = true;
    drainQueue();
  });
  process.stdin.on('error', () => { inputEnded = true; drainQueue(); });
  if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();
}

async function main() {
  if (OPTS.help) {
    process.stdout.write(usageText(OPTS.lang) + '\n');
    return 0;
  }

  // 先探一次后端：连不上就干脆别进全屏，直接给人话
  let first;
  try {
    const res = await apiRequest('GET', OPTS.server + '/api/state', undefined, 2500);
    if (!res.data || !res.data.state) throw new Error(I18N.t(OPTS.lang, 'conn.badState'));
    first = res.data.state;
  } catch (err) {
    const reason = err && err.message ? err.message : err;
    process.stderr.write(
      I18N.t(OPTS.lang, 'tui.connectFailed', { server: OPTS.server }) + '\n' +
      '  ' + reason + '\n\n' +
      I18N.t(OPTS.lang, 'tui.connectFailedHint') + '\n' +
      '    node server.js --port 8123\n' +
      '    node tui.js --server ' + OPTS.server + '\n'
    );
    return 1;
  }

  app.connected = true;
  app.state = first;
  initCursor(first);

  // 无论正常退出、Ctrl+C、SIGTERM 还是崩了，都要把终端还原回去
  process.on('exit', restoreTerminal);
  const onSignal = code => () => { shutdown(code); process.exit(code); };
  process.on('SIGINT', onSignal(130));
  process.on('SIGTERM', onSignal(143));
  process.on('SIGHUP', onSignal(129));
  const onCrash = err => {
    restoreTerminal();
    process.stderr.write('\n' + tr('tui.crashed', { error: (err && err.stack) || err }) + '\n');
    process.exit(1);
  };
  process.on('uncaughtException', onCrash);
  process.on('unhandledRejection', onCrash);

  readSize();
  enterTerminal();
  process.stdout.on('resize', () => { readSize(); requestRender(); render(); });

  render();
  startInput();
  pollTimer = setTimeout(poll, 120);
  return undefined;
}

main().then(code => {
  if (typeof code === 'number') process.exitCode = code;
}).catch(err => {
  restoreTerminal();
  process.stderr.write(tr('tui.crashed', { error: (err && err.message) || err }) + '\n');
  process.exitCode = 1;
});
