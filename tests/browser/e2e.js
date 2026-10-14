'use strict';
/*
 * 网页界面端到端测试（在线模式）
 *
 *   1. 先启动后端：node server.js --port 8123
 *   2. 再跑本测试：node tests/browser/e2e.js
 *
 * 所有操作都用真实鼠标事件完成，检查的是「用户点下去会发生什么」。
 * 最后一项专门验证「网页与终端共用同一局棋」：直接用 HTTP 接口走一步
 * （模拟终端 TUI 的动作），网页应当自动跟上。
 */
const P = require('./page');

const API = process.env.SK_API || 'http://127.0.0.1:8123';

async function api(route, body) {
  const res = await fetch(API + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return res.json();
}

async function main() {
  const s = await P.open({ width: 1400, height: 1100 });
  console.log('网页端到端测试（在线模式，共用后端服务）');

  // 0. 应当连上后端而不是退回离线模式
  const mode = await s.eval('window.__surakarta.mode');
  const label = await s.eval(`document.getElementById('link-status').textContent`);
  P.check('页面连接的是后端服务', mode === 'http', 'mode=' + mode + ' label=' + label);
  console.log('      连接方式：' + label);

  // 从干净的一局开始，并用最快的一档，测试跑得快
  await api('/api/new', { level: 0, humanSide: 1 });
  await P.sleep(400);

  const init = await s.eval(`(() => { const g = window.__surakarta.game;
    return { black: g.counts.black, red: g.counts.red, side: g.side, human: g.humanSide, status: g.status }; })()`);
  P.check('开局 12:12、黑方先行、人类执黑',
    init.black === 12 && init.red === 12 && init.side === 1 && init.human === 1, JSON.stringify(init));

  // 1. 选中棋子出现提示
  await P.clickCell(s, 1, 1);
  const sel = await s.eval(`(() => { const S = window.__surakarta;
    return { selected: S.ui.selected, hints: S.ui.hints.length }; })()`);
  P.check('点击自己的棋子会出现落点提示', sel.selected === 7 && sel.hints > 0, JSON.stringify(sel));

  // 2. 点提示点走子，AI 随后应手
  const target = await s.eval(`window.__surakarta.ui.hints[0].to`);
  await P.clickCell(s, Math.floor(target / 6), target % 6);
  const afterHuman = await P.waitFor(s, `window.__surakarta.game.moves.length >= 1 ? 1 : 0`, 5000);
  P.check('人类走子被记录', !!afterHuman, '未记录到走子');

  const afterAI = await P.waitForHumanTurn(s, 2, 30000);
  const state2 = await s.eval(`(() => { const g = window.__surakarta.game, I = window.SurakartaI18n;
    return { moves: g.moves.length, side: g.side,
             // 着法本身是与语言无关的结构化数据，打印时按当前语言渲染一遍
             log: g.moves.map(m => I.formatMove(window.__surakarta.locale, m)),
             nodes: document.getElementById('stat-nodes').textContent }; })()`);
  P.check('AI 应手后轮次交还人类', afterAI >= 2 && state2.side === 1, JSON.stringify(state2));
  console.log('      着法记录：' + state2.log.join('  '));

  // 3. 悔棋：一次撤回双方各一步
  const beforeUndo = await s.eval('window.__surakarta.game.moves.length');
  await s.eval(`document.getElementById('btn-undo').click(); true`);
  const undone = await P.waitFor(s, `(() => { const g = window.__surakarta.game;
    return (g.moves.length === 0 && g.counts.black === 12 && g.counts.red === 12) ? 1 : 0; })()`, 5000);
  P.check('悔棋一次撤回双方各一步并复原子力', !!undone, `走子前 ${beforeUndo} 手`);

  // 4. 换边：人类执红时由 AI（黑）先行
  await s.eval(`document.querySelector('.side-btn[data-side="2"]').click(); true`);
  const swapped = await P.waitForHumanTurn(s, 1, 30000);
  const swapState = await s.eval(`(() => { const g = window.__surakarta.game;
    return { human: g.humanSide, side: g.side, moves: g.moves.length }; })()`);
  P.check('换边为红方后由 AI 执黑先行',
    swapState.human === 2 && swapState.moves >= 1 && swapState.side === 2, JSON.stringify(swapState));

  // 5. 四档难度都能应手
  await s.eval(`document.querySelector('.side-btn[data-side="1"]').click(); true`);
  await P.sleep(300);
  const timings = [];
  for (const level of [0, 1, 2, 3]) {
    await api('/api/new', { level, humanSide: 1 });
    await P.sleep(350);
    await P.clickCell(s, 1, 1);
    const to = await s.eval('(() => { const S = window.__surakarta; return S.ui.hints.length ? S.ui.hints[0].to : -1; })()');
    if (to < 0) { P.check(`难度 ${level + 1} 能正常应手`, false, '没有可走提示'); continue; }
    await P.clickCell(s, Math.floor(to / 6), to % 6);
    const t0 = Date.now();
    const ok = await P.waitForHumanTurn(s, 2, 40000);
    const depth = await s.eval(`document.getElementById('stat-depth').textContent`);
    timings.push(`${level + 1}档 ${((Date.now() - t0) / 1000).toFixed(1)}s 深度${depth}`);
    P.check(`难度 ${level + 1} 能正常应手`, !!ok, '未在时限内应手');
  }
  console.log('      各档应手耗时：' + timings.join('，'));

  // 6. 关键：网页与终端共用同一局棋 —— 用接口走一步（相当于终端里的操作），网页应当自动跟上
  await api('/api/new', { level: 0, humanSide: 1 });
  await P.sleep(400);
  const before = await s.eval('window.__surakarta.game.moves.length');
  const remote = await api('/api/state');
  await api('/api/move', { move: remote.state.legal[0] });
  const seen = await P.waitFor(s, `window.__surakarta.game.moves.length > ${before} ? 1 : 0`, 6000);
  P.check('接口（终端）走的棋，网页不刷新也能看到', !!seen, '网页未跟上后端的改动');

  const remote2 = await api('/api/state');
  await api('/api/undo', {});
  const seenUndo = await P.waitFor(s, `window.__surakarta.game.moves.length === 0 ? 1 : 0`, 6000);
  P.check('接口（终端）悔棋，网页同样跟上', !!seenUndo);

  // 7. 终局提示
  await api('/api/new', { level: 0, humanSide: 1 });
  await P.sleep(300);
  await api('/api/agree', {});
  const ended = await P.waitFor(s, `window.__surakarta.game.status === 'over' ? 1 : 0`, 6000);
  const message = await s.eval(`document.getElementById('message').textContent`);
  P.check('后端判定的终局会显示在网页上', !!ended && message.length > 0, '提示：' + message);

  P.check('页面运行期间没有 JS 异常', s.pageErrors.length === 0, s.pageErrors.slice(0, 3).join(' | '));

  await api('/api/new', { level: 1, humanSide: 1 });
  await P.sleep(300);
  await s.shot('/tmp/surakarta-e2e.png');
  s.dispose();
  process.exit(P.summary('网页端到端测试全部通过。') === 0 ? 0 : 1);
}

main().catch(e => { console.error('驱动脚本异常：', e.message); process.exit(2); });
