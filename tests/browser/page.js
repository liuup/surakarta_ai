'use strict';
/*
 * 界面测试的公共工具：断言、鼠标事件、等待与画布取指纹。
 * 这些测试直接操作用户看得见的东西——真实鼠标事件与画布像素——
 * 而不是去调用页面内部的函数，因此界面渲染或事件绑定的问题能被发现。
 */
const { launch, sleep } = require('./cdp');

const DEFAULT_URL = process.env.SK_URL || 'http://127.0.0.1:8123/index.html';

let failures = 0;
function check(name, cond, extra) {
  if (cond) {
    console.log('  ✓ ' + name);
  } else {
    failures++;
    console.log('  ✗ ' + name + (extra ? '  → ' + extra : ''));
  }
  return !!cond;
}
function failed() { return failures; }
function summary(okText) {
  console.log(failures === 0 ? '\n' + okText : `\n${failures} 项检查失败。`);
  return failures;
}

/** 打开游戏页面，并收集运行期间的 JS 异常 */
async function open(opts = {}) {
  const s = await launch(opts);
  const errors = [];
  s.ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      errors.push((d.exception && d.exception.description) || d.text);
    } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      errors.push(m.params.args.map(a => (a.value !== undefined ? a.value : a.description)).join(' '));
    }
  });
  await s.send('Page.navigate', { url: opts.url || DEFAULT_URL });
  await sleep(1200);
  const ready = await s.eval('!!(window.__surakarta && window.__surakarta.game)');
  if (!ready) throw new Error('页面未能初始化，请确认本地服务器已启动且地址正确：' + (opts.url || DEFAULT_URL));
  s.pageErrors = errors;
  return s;
}

/** 某个交叉点（行, 列）在页面上的像素坐标 */
function point(session, r, c) {
  return session.eval(`window.__surakarta.cellPoint(${r * 6 + c})`);
}

async function dispatch(session, type, x, y, buttons) {
  await session.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, buttons });
}

async function clickCell(session, r, c) {
  const p = await point(session, r, c);
  await dispatch(session, 'mousePressed', p.x, p.y, 1);
  await dispatch(session, 'mouseReleased', p.x, p.y, 0);
  await sleep(60);
}

async function hoverCell(session, r, c) {
  const p = await point(session, r, c);
  await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, buttons: 0 });
  await sleep(120);
}

async function hoverAway(session) {
  await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 3, y: 3, buttons: 0 });
  await sleep(120);
}

/** 画布当前画面的指纹：同样的局面与标记应当得到同样的值 */
function canvasSignature(session) {
  return session.eval(`(() => {
    const cv = document.getElementById('board');
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    let h = 0;
    for (let i = 0; i < d.length; i += 97) h = (Math.imul(h, 31) + d[i]) >>> 0;
    return h;
  })()`);
}

/** 反复求值直到条件成立或超时 */
async function waitFor(session, expression, timeoutMs = 25000, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await session.eval(expression);
    if (last) return last;
    if (Date.now() >= deadline) return last;
    await sleep(intervalMs);
  }
}

/** 等 AI 走完一手（人类的回合且不在思考） */
function waitForHumanTurn(session, minMoves, timeoutMs = 25000) {
  return waitFor(session,
    `(() => { const g = window.__surakarta.game;
       return (g.moves.length >= ${minMoves} && !g.thinking && g.side === g.humanSide) ? g.moves.length : 0; })()`,
    timeoutMs);
}

module.exports = {
  open, check, failed, summary, sleep,
  point, clickCell, hoverCell, hoverAway, canvasSignature, waitFor, waitForHumanTurn
};
