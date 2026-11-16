const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'chatgpt-phase5-diagnostics.user.js'), 'utf8');

function boot() {
  const menus = new Map();
  const instances = [];
  let createdBlob = null;
  let downloads = 0;
  let intervals = 0;
  class MockPO {
    static supportedEntryTypes = ['long-animation-frame', 'longtask', 'event'];
    constructor(callback) {
      this.callback = callback;
      this.type = null;
      this.disconnected = false;
      instances.push(this);
    }
    observe(options) { this.type = options.type; }
    disconnect() { this.disconnected = true; }
    emit(entries) { this.callback({ getEntries: () => entries }); }
  }
  class MockURL extends URL {
    static createObjectURL(blob) { createdBlob = blob; return 'blob:mock'; }
    static revokeObjectURL() {}
  }
  const page = {
    hidden: false,
    createElement: () => ({
      style: {},
      click: () => { downloads++; },
      remove() {},
    }),
    documentElement: { appendChild() {} },
    querySelectorAll: () => Array.from({ length: 25 }),
    getElementsByTagName: () => Array.from({ length: 100 }),
    visibilityState: 'visible',
  };
  let clock = 100;
  const context = vm.createContext({
    Blob, URL: MockURL, location: { origin: 'https://chatgpt.com' },
    document: page,
    performance: { now: () => (clock += 10), memory: { usedJSHeapSize: 12345 } },
    PerformanceObserver: MockPO,
    GM_registerMenuCommand: (label, callback) => menus.set(label, callback),
    setTimeout: () => 1, clearInterval: () => {},
    setInterval: () => (++intervals), console: { info() {}, warn() {} },
  });
  vm.runInContext(source, context, { timeout: 1000 });
  return { menus, instances, getBlob: () => createdBlob, getDownloads: () => downloads, getIntervals: () => intervals };
}

test('Phase 5 remains passive until explicitly started', () => {
  const env = boot();
  assert.equal(env.menus.size, 3);
  assert.equal(env.instances.length, 0);
  assert.equal(env.getIntervals(), 0);
});

test('captures thresholded events and redacts script identifiers without patching page objects', async () => {
  const env = boot();
  env.menus.get('Phase 5：开始采样')();
  assert.deepEqual(env.instances.map((x) => x.type),
    ['long-animation-frame', 'longtask', 'event']);
  const loaf = env.instances.find((x) => x.type === 'long-animation-frame');
  loaf.emit([{
    startTime: 150, duration: 123, renderStart: 170, styleAndLayoutStart: 180,
    scripts: [
      { duration: 90, forcedStyleAndLayoutDuration: 65, sourceURL:
        'https://chatgpt.com/c/secret-conversation-id?auth=private',
        sourceFunctionName: 'updateViewport' },
      { duration: 15, forcedStyleAndLayoutDuration: 7,
        sourceURL: 'https://chatgpt.com/cdn/assets/abc.js?token=private' },
    ],
  }]);
  env.instances.find((x) => x.type === 'longtask').emit([{
    startTime: 155, duration: 101, name: 'self',
  }]);
  env.instances.find((x) => x.type === 'event').emit([{
    startTime: 159, duration: 130, name: 'click', interactionId: 12,
    processingStart: 175, processingEnd: 245,
  }]);
  env.menus.get('Phase 5：停止采样')();
  assert.ok(env.instances.every((x) => x.disconnected));
  env.menus.get('Phase 5：导出 JSON 报告')();
  assert.equal(env.getDownloads(), 1);
  const json = await env.getBlob().text();
  const data = JSON.parse(json);
  assert.equal(data.summary.totalLoafCount, 1);
  assert.equal(data.summary.totalLongTaskCount, 1);
  assert.equal(data.summary.totalThresholdedEventCount, 1);
  assert.equal(data.recording.events[0].inputDelayMs, 16);
  assert.equal(data.recording.events[0].processingMs, 70);
  assert.equal(data.recording.events[0].presentationDelayMs, 44);
  assert.ok(json.includes('(chatgpt non-asset script)'));
  assert.ok(json.includes('/cdn/assets/abc.js'));
  assert.ok(!json.includes('secret-conversation-id'));
  assert.ok(!json.includes('token=private'));
  assert.ok(!json.includes('auth=private'));
});

test('repeated start while already recording does not register duplicate observers', () => {
  const env = boot();
  const start = env.menus.get('Phase 5：开始采样');
  start();
  start();
  assert.equal(env.instances.length, 3);
});
