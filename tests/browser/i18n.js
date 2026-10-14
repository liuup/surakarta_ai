'use strict';
/*
 * 双语切换的界面测试（node tests/browser/i18n.js）
 *
 *   1. 先启动后端：node server.js --port 8123
 *   2. 再跑本测试：node tests/browser/i18n.js
 *
 * 检查的是「切了语言之后，用户看到的整页文字真的换了语言」——包括由后端数据渲染出来的
 * 着法记录与终局说明。判断办法是直接扫整页文本里有没有汉字，比逐个元素断言更难糊弄过去。
 */
const P = require('./page');

const API = process.env.SK_API || 'http://127.0.0.1:8123';
const CJK = /[㐀-䶿一-鿿　-〿＀-￯]/;

async function api(route, body) {
  const res = await fetch(API + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return res.json();
}

/*
 * 整页可见文字。语言切换按钮自己是个例外——它必须用各自的语言写出「English」和「中文」，
 * 才能让人看懂该点哪个，所以扫汉字时把它整块排除（与 tests/i18n.test.js 里
 * tui.help.langKeys 的处理同理）。
 */
const pageText = s => s.eval(`(() => {
  const sw = document.getElementById('lang-switch');
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let out = '', n;
  while ((n = walker.nextNode())) {
    if (sw && sw.contains(n)) continue;
    const t = n.nodeValue.trim();
    if (t) out += t + ' ';
  }
  return out;
})()`);
const lang = s => s.eval('window.__surakarta.locale');
const switchTo = async (s, code) => {
  await s.eval(`document.querySelector('.lang-btn[data-locale="${code}"]').click(); true`);
  await P.sleep(250);
};

function firstCJK(text) {
  const m = text.match(CJK);
  if (!m) return '';
  const at = text.indexOf(m[0]);
  return '…' + text.slice(Math.max(0, at - 25), at + 25).replace(/\n/g, ' ') + '…';
}

async function main() {
  await api('/api/new', { level: 0, humanSide: 1 });
  const s = await P.open({ width: 1300, height: 1050 });
  console.log('双语切换界面测试');

  // 1. 默认英文
  P.check('默认语言是英文', (await lang(s)) === 'en', 'locale=' + await lang(s));
  P.check('<html lang> 跟着语言走', (await s.eval('document.documentElement.lang')) === 'en');

  const enText = await pageText(s);
  P.check('英文界面里没有任何汉字', !CJK.test(enText), '发现：' + firstCJK(enText));
  P.check('标题与按钮是英文',
    (await s.eval('document.querySelector("h1").textContent')) === 'Surakarta' &&
    (await s.eval('document.getElementById("btn-new").textContent')) === 'New game');
  P.check('规则说明也是英文',
    /corner loop/.test(await s.eval('document.querySelector(".rules ul").innerText')));

  // 2. 走一步，确认着法记录（由后端数据渲染）是英文
  await P.clickCell(s, 1, 1);
  await P.waitFor(s, 'window.__surakarta.ui.hints.length > 0 ? 1 : 0', 5000);
  const to = await s.eval('window.__surakarta.ui.hints[0].to');
  await P.clickCell(s, Math.floor(to / 6), to % 6);
  await P.waitForHumanTurn(s, 2, 30000);

  const enLog = await s.eval('document.getElementById("move-list").innerText');
  P.check('英文化的着法记录由后端数据渲染', /^[BR] [a-f][1-6]→[a-f][1-6]/.test(enLog.trim()), JSON.stringify(enLog));
  P.check('着法记录里没有汉字', !CJK.test(enLog), '发现：' + firstCJK(enLog));

  // 3. 切到中文
  await switchTo(s, 'zh');
  P.check('切换到中文', (await lang(s)) === 'zh');
  P.check('<html lang> 变成 zh-CN', (await s.eval('document.documentElement.lang')) === 'zh-CN');

  const zhText = await pageText(s);
  P.check('中文界面里出现了汉字', CJK.test(zhText));
  // 回归：连接状态那行文字是由「当前驱动」生成的，不是固定文案。
  // 早先它在 index.html 里带着 data-i18n，于是每次切语言都被「正在探测后端服务…」
  // 这个占位覆盖掉——明明连着后端，界面上却写着正在找后端。
  const zhLink = await s.eval(`document.getElementById('link-status').textContent`);
  P.check('切语言后连接状态仍是实际状态', /在线/.test(zhLink) && !/探测/.test(zhLink), JSON.stringify(zhLink));
  P.check('标题与按钮变成中文',
    (await s.eval('document.querySelector("h1").textContent')) === '苏拉卡尔塔' &&
    (await s.eval('document.getElementById("btn-new").textContent')) === '新对局');
  P.check('难度名变成中文', /大师/.test(await s.eval('document.querySelector(".level-grid").innerText')));

  const zhLog = await s.eval('document.getElementById("move-list").innerText');
  P.check('同一局棋的着法记录改用中文渲染', /[黑红] [a-f][1-6]→[a-f][1-6]/.test(zhLog.trim()), JSON.stringify(zhLog));
  P.check('英文与中文渲染的是同一手棋',
    enLog.replace(/[^a-f1-6→]/g, '') === zhLog.replace(/[^a-f1-6→]/g, ''),
    `en=${enLog} zh=${zhLog}`);

  // 4. 终局说明也要跟着语言走
  await api('/api/agree', {});
  const zhResult = await P.waitFor(s, `document.getElementById('message').textContent.length > 0 ? document.getElementById('message').textContent : ''`, 6000);
  P.check('中文终局说明', !!zhResult && CJK.test(zhResult), JSON.stringify(zhResult));
  await switchTo(s, 'en');
  const enResult = await s.eval(`document.getElementById('message').textContent`);
  P.check('同一条终局说明切换后变成英文', !!enResult && !CJK.test(enResult), JSON.stringify(enResult));
  console.log('      中文：' + zhResult);
  console.log('      英文：' + enResult);

  // 5. 选择要记住：刷新后仍是刚才选的英文
  await s.send('Page.reload');
  await P.sleep(1500);
  P.check('刷新后语言选择被记住', (await lang(s)) === 'en', 'locale=' + await lang(s));

  // 6. 切回中文并刷新，同样记住
  await switchTo(s, 'zh');
  await s.send('Page.reload');
  await P.sleep(1500);
  P.check('换成中文后刷新也记住', (await lang(s)) === 'zh', 'locale=' + await lang(s));

  // 7. 中文模式下界面依然工作（切完语言还能正常落子）
  await api('/api/new', { level: 0, humanSide: 1 });
  await P.sleep(400);
  await P.clickCell(s, 1, 1);
  await P.waitFor(s, 'window.__surakarta.ui.hints.length > 0 ? 1 : 0', 5000);
  const to2 = await s.eval('window.__surakarta.ui.hints[0].to');
  await P.clickCell(s, Math.floor(to2 / 6), to2 % 6);
  const played = await P.waitForHumanTurn(s, 2, 30000);
  P.check('切换语言后对局照常进行', played >= 2, 'moves=' + played);

  P.check('整个过程没有 JS 异常', s.pageErrors.length === 0, s.pageErrors.slice(0, 2).join(' | '));

  await s.shot('/tmp/surakarta-i18n.png');
  s.dispose();
  process.exit(P.summary('双语切换界面测试全部通过。') === 0 ? 0 : 1);
}

main().catch(e => { console.error('驱动脚本异常：', e.message); process.exit(2); });
