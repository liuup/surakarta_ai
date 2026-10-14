'use strict';
/*
 * 极简 Chrome DevTools Protocol 客户端，供 tests/browser/ 下的界面测试使用。
 * 只用 Node 内置能力（node:child_process、node:fs 与全局 WebSocket、fetch），
 * 不需要安装任何 npm 包。
 *
 * Chrome 的位置可以用 CHROME_PATH 指定；否则会依次尝试几个常见路径。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
].filter(Boolean);

function findChrome() {
  for (const candidate of CANDIDATES) {
    try { if (fs.statSync(candidate).isFile()) return candidate; } catch (e) { /* 继续找 */ }
  }
  throw new Error('找不到 Chrome，请用 CHROME_PATH 环境变量指定可执行文件路径。已尝试：\n  ' +
    CANDIDATES.join('\n  '));
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchJson(url, tries = 80) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      return await res.json();
    } catch (e) {
      await sleep(250);
    }
  }
  throw new Error('无法连接 Chrome 调试端口：' + url);
}

class Session {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    ws.addEventListener('message', ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('CDP 调用超时：' + method));
        }
      }, 120000);
    });
  }

  /** 在页面里求值并取回结果；页面抛出异常时在这里抛出 */
  async eval(expression, awaitPromise = false) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error('页面内异常：' + ((d.exception && d.exception.description) || d.text));
    }
    return r.result.value;
  }

  async shot(file) {
    const m = await this.send('Page.getLayoutMetrics');
    await this.send('Emulation.setDeviceMetricsOverride', {
      width: Math.ceil(m.cssContentSize.width),
      height: Math.ceil(m.cssContentSize.height),
      deviceScaleFactor: 1, mobile: false
    });
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  }

  close() { try { this.ws.close(); } catch (e) { /* 忽略 */ } }
}

/** 启动一个无头 Chrome，打开空白页，返回可用的会话 */
async function launch({ width = 1280, height = 1000 } = {}) {
  const chrome = findChrome();
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'surakarta-chrome-'));
  const port = 9300 + Math.floor(Math.random() * 600);
  const proc = spawn(chrome, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', '--mute-audio', '--disable-extensions',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDir}`,
    `--window-size=${width},${height}`,
    'about:blank'
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  proc.stderr.on('data', () => {});            // 无头模式下 Chrome 会刷大量无关日志

  const list = await fetchJson(`http://127.0.0.1:${port}/json/list`);
  const page = list.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });

  const session = new Session(ws);
  await session.send('Page.enable');
  await session.send('Runtime.enable');
  await session.send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 1, mobile: false
  });
  session.dispose = () => {
    session.close();
    try { proc.kill('SIGKILL'); } catch (e) { /* 忽略 */ }
    try { fs.rmSync(userDir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  };
  return session;
}

module.exports = { launch, sleep, findChrome };
