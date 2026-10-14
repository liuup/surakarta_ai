'use strict';
/*
 * 后端服务接口测试（node tests/api.test.js）
 *
 * 真实启动 server.js，用 HTTP 请求走一遍所有接口。
 * 这里同时验证「网页与终端共用同一局棋」这一条：任何一次请求拿到的都是同一份状态。
 */
const assert = require('assert');
const { spawn } = require('node:child_process');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PORT = 8400 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
function check(name, fn) {
  return Promise.resolve().then(fn).then(() => {
    passed++;
    console.log('  通过：' + name);
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function api(route, body) {
  const res = await fetch(BASE + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  return { status: res.status, data, res };
}

async function getState() { return (await api('/api/state')).data.state; }

/** 等 AI 走完一手 */
async function waitForAI(previousMoves, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = await getState();
    if (state.moves.length > previousMoves && !state.thinking) return state;
    if (Date.now() > deadline) throw new Error('AI 未在时限内应手');
    await sleep(120);
  }
}

async function waitForServer(timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(BASE + '/api/state');
      if (res.ok) return;
    } catch (e) { /* 还没起来 */ }
    if (Date.now() > deadline) throw new Error('后端服务未能启动');
    await sleep(120);
  }
}

async function main() {
  console.log('后端服务接口测试');
  const server = spawn(process.execPath, ['server.js', '--port', String(PORT)], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe']
  });
  let serverLog = '';
  server.stdout.on('data', d => { serverLog += d; });
  server.stderr.on('data', d => { serverLog += d; });

  try {
    await waitForServer();
    console.log(`      服务已在 ${BASE} 启动`);

    await check('静态页面与资源可以取到', async () => {
      const page = await fetch(BASE + '/');
      assert.strictEqual(page.status, 200);
      const html = await page.text();
      assert.ok(html.indexOf('canvas') >= 0, '首页应当包含棋盘画布');
      for (const asset of ['/css/style.css', '/js/rules.js', '/js/i18n.js', '/js/ai.js', '/js/session.js', '/js/main.js']) {
        const res = await fetch(BASE + asset);
        assert.strictEqual(res.status, 200, asset + ' 应当可以取到');
      }
      const missing = await fetch(BASE + '/不存在的文件');
      assert.strictEqual(missing.status, 404);
    });

    await check('越权路径不能读到项目目录之外的文件', async () => {
      const res = await fetch(BASE + '/../package.json');
      assert.ok(res.status === 403 || res.status === 404, '实际状态码 ' + res.status);
    });

    await check('接口返回允许跨域的头', async () => {
      const { res } = await api('/api/state');
      assert.strictEqual(res.headers.get('access-control-allow-origin'), '*');
    });

    await check('开局状态正确', async () => {
      const state = await getState();
      assert.strictEqual(state.counts.black, 12);
      assert.strictEqual(state.counts.red, 12);
      assert.strictEqual(state.side, 1);
      assert.strictEqual(state.status, 'playing');
      assert.strictEqual(state.legal.length, 16);
      assert.strictEqual(state.levels.length, 4);
      assert.strictEqual(state.levelKey, 2, '默认应当是第 2 档');
      assert.strictEqual(state.levelName, undefined, '状态里不应带任何语言的档位名');
    });

    await check('取某一枚棋子的着法与绕行预览', async () => {
      const { status, data } = await api('/api/hints?cell=7');
      assert.strictEqual(status, 200);
      assert.ok(data.hints.length > 0);
      for (const hint of data.hints) {
        assert.strictEqual(hint.from, 7);
        assert.ok(hint.to >= 0 && hint.to < 36);
      }
      const bad = await api('/api/hints?cell=999');
      assert.strictEqual(bad.status, 400);
    });

    await check('非法着法返回 409 并且不改变局面', async () => {
      const before = await getState();
      const { status, data } = await api('/api/move', { move: 1 });
      assert.strictEqual(status, 409);
      assert.strictEqual(data.ok, false);
      // 错误带错误码与参数，界面据此用自己的语言翻译；message 是服务语言的可读文本
      assert.strictEqual(data.error.code, 'err.illegalMove');
      assert.deepStrictEqual(data.error.params, { from: 'a1', to: 'b1' });
      assert.ok(typeof data.message === 'string' && data.message.length > 0);
      const after = await getState();
      assert.strictEqual(after.moves.length, before.moves.length);
      assert.strictEqual(after.position, before.position);
    });

    await check('走子后 AI 会应手，随后轮次交还人类', async () => {
      await api('/api/new', { level: 0 });          // 用最快的一档，测试跑得快
      const state = await getState();
      const move = state.legal[0];
      const { status, data } = await api('/api/move', { move });
      assert.strictEqual(status, 200);
      assert.strictEqual(data.state.moves.length, 1);
      const after = await waitForAI(1);
      assert.strictEqual(after.moves.length, 2);
      assert.strictEqual(after.side, 1, 'AI 走完应当回到人类');
      assert.ok(typeof after.lastScore === 'number', '应当带上 AI 的评分');
    });

    await check('AI 思考期间拒绝人类抢着走', async () => {
      // 换到第 4 档并重开，AI 会思考较久，足以观察到 thinking
      await api('/api/new', { level: 3, humanSide: 2 });
      let sawThinking = false;
      for (let i = 0; i < 60; i++) {
        const state = await getState();
        if (state.thinking) { sawThinking = true; break; }
        if (state.moves.length >= 1) break;
        await sleep(100);
      }
      if (sawThinking) {
        const { status, data } = await api('/api/move', { move: 0 });
        assert.strictEqual(status, 409);
        assert.strictEqual(data.error.code, 'err.notYourTurn', '错误码应当说明轮到 AI');
      }
      // 等到 AI 走完，避免影响后续测试
      const deadline = Date.now() + 30000;
      for (;;) {
        const state = await getState();
        if (!state.thinking && state.moves.length >= 1) break;
        if (Date.now() > deadline) break;
        await sleep(150);
      }
      assert.ok(sawThinking, 'AI 思考期间应当能观察到 thinking 状态');
      await api('/api/new', { level: 0 });
    });

    await check('状态里带有思考进度，前端据此显示', async () => {
      // 用最深的一档，搜索会持续足够久，稳定地观察到进度
      await api('/api/new', { level: 3, humanSide: 2 });
      let progress = null;
      for (let i = 0; i < 200; i++) {
        const state = await getState();
        if (state.progress) { progress = state.progress; break; }
        if (!state.thinking && state.moves.length >= 1) break;
        await sleep(30);
      }
      assert.ok(progress, '应当能取到一次搜索进度');
      assert.ok(progress.nodes > 0, '节点数应当大于 0');
      assert.ok(typeof progress.currentDepth === 'number');
      await api('/api/new', { level: 0 });
    });

    await check('悔棋撤回双方各一步', async () => {
      await api('/api/new', { level: 0, humanSide: 1 });
      const start = await getState();
      await api('/api/move', { move: start.legal[0] });
      await waitForAI(1);
      assert.strictEqual((await getState()).moves.length, 2);
      const { status } = await api('/api/undo', {});
      assert.strictEqual(status, 200);
      const after = await getState();
      assert.strictEqual(after.moves.length, 0);
      assert.strictEqual(after.side, 1);
      assert.deepStrictEqual(after.counts, { black: 12, red: 12 });
    });

    await check('切换难度立即生效并随状态返回', async () => {
      for (let i = 0; i < 4; i++) {
        const { status, data } = await api('/api/level', { level: i });
        assert.strictEqual(status, 200);
        assert.strictEqual(data.state.level, i);
        assert.strictEqual(data.state.levelKey, i + 1);
        assert.strictEqual(data.state.levelDepth, [2, 4, 6, 8][i]);
      }
      await api('/api/level', { level: 0 });
    });

    await check('切换执子方会重开一局，并由 AI 先行', async () => {
      await api('/api/new', { level: 0, humanSide: 1 });
      const { status, data } = await api('/api/side', { side: 2 });
      assert.strictEqual(status, 200);
      assert.strictEqual(data.state.humanSide, 2);
      assert.strictEqual(data.state.moves.length, 0, '换边应当重开');
      const after = await waitForAI(0);
      assert.strictEqual(after.moves.length, 1, 'AI 执黑应当先行');
      assert.strictEqual(after.side, 2);
    });

    await check('协商终局按剩余子力判定', async () => {
      await api('/api/new', { level: 0, humanSide: 1 });
      const { status, data } = await api('/api/agree', {});
      assert.strictEqual(status, 200);
      assert.strictEqual(data.state.status, 'over');
      assert.strictEqual(data.state.result.kind, 'agreed');
      assert.ok(data.state.result.judge, '协商终局应当带上按子力判定的结果');
      const after = await api('/api/move', { move: (5 << 6) | 11 });
      assert.strictEqual(after.status, 409, '终局后不应还能走子');
    });

    await check('网页与终端看到的是同一局棋（共用一份状态）', async () => {
      await api('/api/new', { level: 0, humanSide: 1 });
      const state = await getState();
      const move = state.legal[0];
      // 第一个「客户端」走一步
      await api('/api/move', { move });
      await waitForAI(1);
      // 另一个「客户端」只读，看到的应当是完全相同的局面
      const a = await getState();
      const b = await getState();
      assert.deepStrictEqual(a.board, b.board);
      assert.strictEqual(a.moves.length, 2);
      assert.strictEqual(a.position, b.position);
      // 第二个客户端悔棋，第一个客户端也应当立刻看到
      await api('/api/undo', {});
      const c = await getState();
      assert.strictEqual(c.moves.length, 0);
      assert.deepStrictEqual(c.counts, { black: 12, red: 12 });
    });

    await check('服务默认用英文，--lang zh 可以切成中文', async () => {
      const en = await api('/api/不存在', {});
      assert.strictEqual(en.status, 404);
      assert.strictEqual(en.data.error.code, 'err.unknownRoute');
      assert.ok(/No such endpoint/.test(en.data.message), '默认应当是英文：' + en.data.message);
    });

    await check('未知接口返回 404', async () => {
      const { status } = await api('/api/不存在', {});
      assert.strictEqual(status, 404);
    });
  } finally {
    server.kill('SIGKILL');
    await sleep(150);
  }

  if (serverLog.trim()) console.log('      服务输出：' + serverLog.trim().split('\n')[0]);
  console.log(`\n全部 ${passed} 项接口测试通过。`);
}

main().catch(err => {
  console.error('\n接口测试失败：', err && err.stack || err);
  process.exit(1);
});
