'use strict';
/*
 * 网页离线模式测试（直接用 file:// 打开，不连后端）
 *
 *   node tests/browser/offline.js
 *
 * 覆盖两件事：
 *   1. 双击 index.html 也能完整对局（本地跑 js/session.js 与 AI）；
 *   2. 绕行预览的重绘回归——鼠标从一个吃子目标移到另一个吃子目标时，
 *      两条绕行路线都必须真的重画出来。这一步用画布像素指纹判定，
 *      只看页面内部的路径数据是抓不到这个缺陷的。
 */
const P = require('./page');
const path = require('node:path');

// ?local=1 强制走本地对局，这样即使本机正好有后端服务在跑，测的也确实是离线路径
const FILE_URL = 'file://' + path.join(__dirname, '..', '..', 'index.html') + '?local=1';

async function main() {
  const s = await P.open({ width: 1200, height: 1000, url: FILE_URL });
  console.log('网页离线模式测试（file:// 直接打开）');

  const mode = await s.eval('window.__surakarta.mode');
  const label = await s.eval(`document.getElementById('link-status').textContent`);
  P.check('没有后端时自动退回本页对局', mode === 'local', 'mode=' + mode + ' label=' + label);
  console.log('      连接方式：' + label);

  const init = await s.eval(`(() => { const g = window.__surakarta.game;
    return { black: g.counts.black, red: g.counts.red, side: g.side, human: g.humanSide }; })()`);
  P.check('开局 12:12、黑方先行、人类执黑',
    init.black === 12 && init.red === 12 && init.side === 1 && init.human === 1, JSON.stringify(init));

  // 1. 离线也能正常走子并等到 AI 应手
  await P.clickCell(s, 1, 1);
  const hints = await s.eval('window.__surakarta.ui.hints.length');
  P.check('点击棋子会出现落点提示', hints > 0, 'hints=' + hints);
  const target = await s.eval('window.__surakarta.ui.hints[0].to');
  await P.clickCell(s, Math.floor(target / 6), target % 6);
  const ok = await P.waitForHumanTurn(s, 2, 30000);
  // 着法本身是与语言无关的结构化数据，打印时按当前语言渲染一遍
  const log = await s.eval(`(() => { const I = window.SurakartaI18n, L = window.__surakarta.locale;
    return window.__surakarta.game.moves.map(m => I.formatMove(L, m)); })()`);
  P.check('离线模式下 AI 也能应手', ok >= 2, 'moves=' + JSON.stringify(log));
  console.log('      着法记录：' + log.join('  '));

  // 2. 界面保持可交互：AI 思考期间点按钮不应抛异常，且操作按钮确实被禁用
  const disabled = await s.eval(`document.getElementById('btn-new').disabled`);
  P.check('AI 思考结束后按钮恢复可用', disabled === false, 'btn-new.disabled=' + disabled);

  // 3. 绕行预览重绘回归：摆一个「同一枚棋子有两个不同方向吃子目标」的局面
  const setup = await s.eval(`(() => {
    const S = window.__surakarta, R = S.rules;
    const board = new Int8Array(R.CELLS);
    board[R.idx(1, 1)] = R.BLACK;
    board[R.idx(4, 1)] = R.RED;   // 向左绕环后沿第 1 列下行可吃
    board[R.idx(4, 4)] = R.RED;   // 向右绕环后沿第 4 列下行可吃
    return S.loadPosition(board, R.BLACK).then(() => S.ui.hints.length);
  })()`, true);
  P.check('调试入口可以载入指定局面（离线模式）', setup === 0, 'hints=' + setup);

  await P.clickCell(s, 1, 1);
  const caps = await s.eval(`(() => { const S = window.__surakarta;
    return S.ui.hints.filter(h => h.capture).map(h => ({ to: h.to, r: Math.floor(h.to / 6), c: h.to % 6, len: h.path ? h.path.length : 0 })); })()`);
  P.check('存在两个不同方向的吃子目标', caps.length === 2, JSON.stringify(caps));
  P.check('每个吃子目标都带有绕行路线', caps.every(c => c.len > 2), JSON.stringify(caps.map(c => c.len)));

  if (caps.length === 2) {
    await P.hoverCell(s, caps[0].r, caps[0].c);
    const sigA = await P.canvasSignature(s);
    await P.hoverCell(s, caps[1].r, caps[1].c);
    const sigB = await P.canvasSignature(s);
    const pathB = await s.eval('window.__surakarta.ui.hoverPath.length');
    await P.hoverCell(s, caps[0].r, caps[0].c);
    const sigA2 = await P.canvasSignature(s);
    await P.hoverAway(s);
    const cleared = await s.eval('window.__surakarta.ui.hoverPath === null');

    P.check('切换吃子目标时画面确实重绘', sigA !== sigB, `sigA=${sigA} sigB=${sigB}`);
    P.check('回到原目标时画面恢复一致', sigA === sigA2, `sigA=${sigA} sigA2=${sigA2}`);
    P.check('鼠标移开后路线消失', cleared === true, String(cleared));
    P.check('悬停时用的是第二个目标的路线', pathB > 2, 'poly=' + pathB);
  }

  // 4. 离线模式下不能在在线模式用调试入口反过来说：这里只确认没有异常
  P.check('页面运行期间没有 JS 异常', s.pageErrors.length === 0, s.pageErrors.slice(0, 3).join(' | '));

  await s.shot('/tmp/surakarta-offline.png');
  s.dispose();
  process.exit(P.summary('网页离线模式测试全部通过。') === 0 ? 0 : 1);
}

main().catch(e => { console.error('驱动脚本异常：', e.message); process.exit(2); });
