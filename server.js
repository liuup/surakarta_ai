#!/usr/bin/env node
'use strict';
/*
 * 苏拉卡尔塔后端服务
 *
 *   node server.js [--port 8123]
 *
 * 同时提供两件事：
 *   1. 静态文件（index.html / css / js），也就是网页版界面；
 *   2. /api/… 上的 JSON 接口，终端界面 tui.js 用的就是这一套。
 *
 * 对局状态只有一份，放在服务里。因此网页和终端 TUI 看到的是**同一局棋**：
 * 在终端里走一步，网页刷新一下就能看到；两个界面也可以同时开着交替落子。
 *
 * 只依赖 Node 内置模块，不需要 npm install。
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createSession } = require('./js/session.js');
const I18N = require('./js/i18n.js');

const ROOT = __dirname;
const session = createSession();

function parseArgs(argv) {
  const opts = { port: 8123, host: '127.0.0.1', lang: null };
  for (let i = 0; i < argv.length; i++) {
    if ((argv[i] === '--port' || argv[i] === '-p') && argv[i + 1]) opts.port = Number(argv[++i]);
    else if (argv[i] === '--host' && argv[i + 1]) opts.host = argv[++i];
    else if (argv[i] === '--lang' && argv[i + 1]) opts.lang = argv[++i];
    else if (argv[i] === '--help' || argv[i] === '-h') opts.help = true;
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));

/* 服务自身的语言：只影响启动横幅与接口里附带的可读错误信息。
 * 两个界面的语言由各自决定——接口返回的错误带的是错误码，界面自己翻译。 */
const LANG = I18N.normalize(opts.lang);
function t(key, params) { return I18N.t(LANG, key, params); }

if (opts.help) {
  console.log(t('server.usage'));
  process.exit(0);
}

// ---------------------------------------------------------------- 静态文件

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8'
};

function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/') rel = '/index.html';
  const target = path.join(ROOT, path.normalize(rel));
  // 只允许访问项目目录内的文件
  if (!target.startsWith(ROOT + path.sep) && target !== ROOT) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end(t('err.forbidden'));
    return;
  }
  fs.readFile(target, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end(t('err.notFound', { path: rel }));
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(data);
  });
}

// ---------------------------------------------------------------- JSON 接口

/*
 * 接口一律允许跨域：这样即使页面是用别的静态服务器（或 file://）打开的，
 * 也照样能连上本地这个后端，从而和终端 TUI 共用同一局棋。
 * 服务只监听本机，接口不涉及任何凭据，开放跨域是安全的。
 */
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400'
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  }, CORS));
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 1 << 20) { reject(new Error('err.tooLarge')); req.destroy(); }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('err.badRequest')); }
    });
    req.on('error', reject);
  });
}

/* 会话返回的错误是 { code, params }，这里再附一条按服务语言渲染好的可读文本，
 * 方便直接用 curl 调试；两个界面则用错误码自己翻译。 */
function errorPayload(err) {
  if (!err) return { code: 'err.actionFailed', params: {} };
  if (typeof err === 'string') return { code: err, params: {} };
  return { code: err.code, params: err.params || {} };
}

function fail(res, status, err) {
  const payload = errorPayload(err);
  sendJson(res, status, {
    ok: false,
    error: payload,
    message: t(payload.code, payload.params),
    state: session.state()
  });
}

/** 一律返回最新状态，前端因此不需要自己维护局面 */
function reply(res, result) {
  if (result && result.ok === false) {
    const payload = errorPayload(result.error);
    sendJson(res, 409, {
      ok: false,
      error: payload,
      message: t(payload.code, payload.params),
      state: session.state()
    });
    return;
  }
  sendJson(res, 200, Object.assign({ ok: true }, result || {}, { state: session.state() }));
}

async function handleApi(req, res, url) {
  const route = url.pathname;
  const method = req.method;

  if (method === 'OPTIONS') {
    res.writeHead(204, CORS).end();
    return;
  }

  if (method === 'GET' && route === '/api/state') {
    return reply(res, {});
  }

  if (method === 'GET' && route === '/api/hints') {
    const cell = Number(url.searchParams.get('cell'));
    if (!(cell >= 0 && cell < 36)) return fail(res, 400, { code: 'err.badCell' });
    return reply(res, { hints: session.movesFrom(cell) });
  }

  if (method === 'GET' && route === '/api/levels') {
    return reply(res, { levels: session.state().levels });
  }

  if (method !== 'POST') return fail(res, 405, { code: 'err.badMethod' });

  let body;
  try { body = await readBody(req); }
  catch (e) { return fail(res, 400, { code: e.message }); }

  switch (route) {
    case '/api/move': {
      if (session.needsAI()) return fail(res, 409, { code: 'err.notYourTurn' });
      const move = Number(body.move);
      if (!Number.isInteger(move)) return fail(res, 400, { code: 'err.missingMove' });
      return reply(res, session.playMove(move));
    }
    case '/api/new':
      return reply(res, { state: session.newGame({ humanSide: body.humanSide, level: body.level }) });
    case '/api/undo':
      return reply(res, session.undo());
    case '/api/agree':
      return reply(res, session.agreeEnd());
    case '/api/level':
      return reply(res, session.setLevel(Number(body.level)));
    case '/api/side':
      return reply(res, session.setHumanSide(Number(body.side)));
    default:
      return fail(res, 404, { code: 'err.unknownRoute', params: { route: route } });
  }
}

// ---------------------------------------------------------------- AI 调度

/*
 * AI 搜索按小块推进：每块约 20 毫秒，然后交还事件循环。
 * 这样即使第 4 档要算好几秒，HTTP 请求依然能被及时处理，
 * 网页和终端都能实时看到「思考中」的进度。
 */
function pumpAI() {
  if (session.needsAI()) {
    if (!session.isThinking()) session.startAI({ chunkMs: 20 });
    const result = session.stepAI();
    if (!result.done) {
      setImmediate(pumpAI);
      return;
    }
  }
  setTimeout(pumpAI, 60);
}

// ---------------------------------------------------------------- 服务

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch(err => {
      sendJson(res, 500, { ok: false, error: { code: 'err.actionFailed', params: {} }, message: String(err && err.message || err) });
    });
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' }).end(t('err.badMethod'));
    return;
  }
  serveStatic(req, res, url.pathname);
});

server.listen(opts.port, opts.host, () => {
  const shown = opts.host === '0.0.0.0' ? localAddresses() : [opts.host];
  console.log(t('server.started'));
  for (const h of shown) console.log(t('server.web', { url: `http://${h}:${opts.port}/` }));
  console.log(t('server.tui', { url: `http://${shown[0]}:${opts.port}` }));
  console.log(t('server.shared'));
  pumpAI();
});

function localAddresses() {
  const list = ['127.0.0.1'];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) list.push(net.address);
    }
  }
  return list;
}

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(t('server.portBusy', { port: opts.port, next: opts.port + 1 }));
  } else {
    console.error(t('server.failed', { error: err.message }));
  }
  process.exit(1);
});

process.on('SIGINT', () => {
  console.log('\n' + t('server.stopped'));
  process.exit(0);
});
