import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../phase6/', import.meta.url)));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

function chromeBinary() {
  for (const name of [process.env.CHROME_BIN, 'chromium', 'google-chrome', 'google-chrome-stable']) {
    if (!name) continue;
    const p = spawnSync(name, ['--version'], { stdio: 'ignore' });
    if (p.status === 0) return name;
  }
  return null;
}

async function createLocalServer() {
  const mime = { '.html': 'text/html', '.css': 'text/css', '.mjs': 'text/javascript' };
  const server = createServer((req, res) => {
    let path;
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      path = resolve(root, '.' + (url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)));
      if (path !== root && !path.startsWith(root + sep)) {
        res.writeHead(403).end('Forbidden');
        return;
      }
    } catch {
      res.writeHead(400).end('Bad request');
      return;
    }
    const input = createReadStream(path);
    input.on('error', () => { if (!res.headersSent) res.writeHead(404); res.end('Not found'); });
    res.setHeader('Content-Type', mime[extname(path)] || 'text/plain');
    input.pipe(res);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { server, url: 'http://127.0.0.1:' + server.address().port + '/' };
}

async function waitFor(check, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) { lastError = error; }
    await pause(80);
  }
  throw new Error('Timed out waiting for browser condition: ' + (lastError?.message || 'unmet'));
}

async function attach(port) {
  const targets = await waitFor(async () => {
    const response = await fetch('http://127.0.0.1:' + port + '/json');
    const all = await response.json();
    return all.find((x) => x.type === 'page' && x.webSocketDebuggerUrl);
  });
  const ws = new WebSocket(targets.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  const pending = new Map();
  const exceptions = [];
  let seq = 0;
  ws.addEventListener('message', (event) => {
    const item = JSON.parse(String(event.data));
    if (item.method === 'Runtime.exceptionThrown') {
      exceptions.push(item.params?.exceptionDetails?.text || 'Uncaught runtime exception');
    }
    if (!item.id || !pending.has(item.id)) return;
    const { resolve, reject } = pending.get(item.id);
    pending.delete(item.id);
    if (item.error) reject(new Error(item.error.message));
    else resolve(item.result);
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evalJs = async (expression) => {
    const answer = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (answer.exceptionDetails) {
      throw new Error(answer.exceptionDetails.text + ': ' + (answer.exceptionDetails.exception?.description || ''));
    }
    return answer.result.value;
  };
  await call('Page.enable');
  await call('Runtime.enable');
  return { ws, call, evalJs, exceptions };
}

test('Phase 6 Chromium smoke: 10k virtual rows, anchor, full baseline, worker import', { timeout: 90000 }, async (t) => {
  const binary = chromeBinary();
  if (!binary) return t.skip('Chromium/Chrome is not installed on this runner');
  const { server, url } = await createLocalServer();
  const userData = await mkdtemp(join(tmpdir(), 'renderlite-phase6-'));
  let chrome;
  let cdp;
  try {
    chrome = spawn(binary, [
      '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
      '--remote-allow-origins=*', '--remote-debugging-port=0',
      '--user-data-dir=' + userData, 'about:blank',
    ], { stdio: 'ignore' });
    const port = await waitFor(async () => {
      const raw = await readFile(join(userData, 'DevToolsActivePort'), 'utf8');
      return Number(raw.split('\n')[0]) || null;
    });
    cdp = await attach(port);
    await cdp.call('Page.navigate', { url });

    await waitFor(async () =>
      (await cdp.evalJs("document.querySelector('#total-count')?.textContent")) === '1,000'
    );
    let stats = await cdp.evalJs("({ total: document.querySelector('#total-count').textContent, mounted: document.querySelectorAll('.turn').length })");
    assert.equal(stats.total, '1,000');
    assert.ok(stats.mounted < 40, 'virtual DOM should remain bounded at 1000 messages');

    await cdp.evalJs("document.querySelector('#demo-size').value='10000';document.querySelector('#load-demo').click()");
    await waitFor(async () =>
      (await cdp.evalJs("document.querySelector('#total-count').textContent")) === '10,000'
    );
    stats = await cdp.evalJs("({mounted:document.querySelectorAll('.turn').length, count:document.querySelector('#total-count').textContent})");
    assert.ok(stats.mounted < 40, 'virtual DOM should remain bounded at 10000 messages');

    await cdp.evalJs("document.querySelector('#jump-middle').click()");
    await pause(200);
    const anchor = await cdp.evalJs("document.querySelector('#scroller').scrollTop");
    assert.ok(anchor > 0);
    await cdp.evalJs("document.querySelector('#prepend').click()");
    await waitFor(async () =>
      (await cdp.evalJs("document.querySelector('#total-count').textContent")) === '10,050'
    );
    const after = await cdp.evalJs("({top:document.querySelector('#scroller').scrollTop, mounted:document.querySelectorAll('.turn').length})");
    assert.ok(after.top > anchor, 'prepending should move the scroll offset to preserve the anchor');
    assert.ok(after.mounted < 40);

    await cdp.evalJs("document.querySelector('#demo-size').value='1000';document.querySelector('#load-demo').click()");
    await cdp.evalJs("document.querySelector('#render-mode').value='full';document.querySelector('#render-mode').dispatchEvent(new Event('change'))");
    await waitFor(async () => (await cdp.evalJs("document.querySelectorAll('.turn').length")) === 1000);

    // Restore virtual mode before importing text from a local Blob.
    await cdp.evalJs("document.querySelector('#render-mode').value='virtual';document.querySelector('#render-mode').dispatchEvent(new Event('change'))");
    const exportData = [{
      id: 'browser-smoke', title: '本地浏览器测试',
      current_node: 'answer', mapping: {
        root: { parent: null, message: null },
        question: { parent: 'root', message: { author: { role: 'user' }, content: { parts: ['你好 <script>not executable</script>'] } } },
        answer: { parent: 'question', message: { author: { role: 'assistant' }, content: { parts: ['这是本地导出，不发送网络请求'] } } },
      },
    }];
    const quoted = JSON.stringify(JSON.stringify(exportData));
    await cdp.evalJs(`(() => {
      const data = new DataTransfer();
      data.items.add(new File([${quoted}], 'conversations.json', { type: 'application/json' }));
      const input = document.querySelector('#file-import');
      input.files = data.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await waitFor(async () => (await cdp.evalJs("document.querySelector('#conversation-title').textContent")).includes('本地浏览器测试'));
    const imported = await cdp.evalJs("({ mounted:document.querySelectorAll('.turn').length, scriptNodes:document.querySelectorAll('script').length, body:document.querySelector('.turn-body')?.textContent })");
    assert.equal(imported.mounted, 2);
    assert.ok(imported.body.includes('<script>not executable</script>'));
    assert.equal(imported.scriptNodes, 1, 'untrusted text must not create script nodes');
    assert.deepEqual(cdp.exceptions, []);
  } finally {
    try { cdp?.ws.close(); } catch {}
    if (chrome) chrome.kill('SIGKILL');
    await new Promise((resolve) => server.close(resolve));
    await rm(userData, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  }
});
