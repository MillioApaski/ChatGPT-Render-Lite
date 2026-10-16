'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const script = fs.readFileSync(path.join(__dirname, '..', 'chatgpt-geometry-cache.user.js'), 'utf8');

function setup({ mode = 'off', route = '/c/test', turnInside = true, ownGetter = false, nativeGetter = true } = {}) {
  let clock = 0;
  let realReads = 0;
  let reloads = 0;
  const storage = new Map();
  storage.set('chatgpt-render-lite:phase4:mode', mode);
  const handlers = new Map();
  const timers = [];
  function on(where, type, fn) { handlers.set(where + ':' + type, fn); }
  function off(where, type) { handlers.delete(where + ':' + type); }
  class Element {}
  if (nativeGetter) Object.defineProperty(Element.prototype, 'clientHeight', { configurable: true, get() { realReads++; return this.height; } });
  class HTMLElement extends Element {
    constructor() { super(); this.height = 500; this.isConnected = true; }
    contains(target) { return turnInside && target === turn; }
  }
  const turn = {};
  const scrollingElement = new HTMLElement();
  const other = new HTMLElement();
  if (ownGetter) Object.defineProperty(scrollingElement, 'clientHeight', { configurable: true, get() { return -1; } });
  const document = {
    visibilityState: 'visible',
    scrollingElement,
    querySelector: () => turn,
    addEventListener(type, fn) { on('document', type, fn); },
    removeEventListener(type) { off('document', type); },
  };
  const location = { pathname: route, reload() { reloads++; } };
  const window = {
    addEventListener(type, fn) { on('window', type, fn); },
    removeEventListener(type) { off('window', type); },
  };
  const context = {
    document, window, Element, HTMLElement,
    location, localStorage: {
      getItem(key) { return storage.get(key) ?? null; },
      setItem(key, value) { storage.set(key, value); },
    },
    performance: { now() { return clock; } },
    setInterval(fn) { timers.push(fn); return timers.length; },
    clearInterval() {},
    console: { warn() {} },
  };
  vm.runInNewContext(script, context);
  return {
    document, location, window, scrollingElement, other, storage, handlers, timers,
    get reads() { return realReads; },
    get reloads() { return reloads; },
    scroll(target = scrollingElement) {
      const cb = handlers.get('document:scroll');
      if (cb) cb({ target });
    },
    advance(ms) { clock += ms; },
    tick() { timers[0]?.(); },
    status() { return window.ChatGPTRenderLitePhase4.status(); },
    get ownPatch() { return Object.hasOwn(scrollingElement, 'clientHeight'); },
  };
}

test('defaults off, no DOM hook/listener, mode selection persists', () => {
  const x = setup();
  assert.equal(x.handlers.size, 0);
  assert.equal(x.ownPatch, false);
  assert.equal(x.status().mode, 'off');
  assert.throws(() => x.window.ChatGPTRenderLitePhase4.setMode('unsafe'));
  x.window.ChatGPTRenderLitePhase4.setMode('observe');
  assert.equal(x.storage.get('chatgpt-render-lite:phase4:mode'), 'observe');
  assert.equal(x.reloads, 1);
});

test('observe mode instruments only actual conversation scroll elements, no caching', () => {
  const x = setup({ mode: 'observe' });
  x.scroll(x.other);
  assert.equal(x.ownPatch, false);
  x.scroll();
  assert.equal(x.ownPatch, true);
  assert.equal(x.scrollingElement.clientHeight, 500);
  x.scrollingElement.height = 600;
  assert.equal(x.scrollingElement.clientHeight, 600);
  assert.equal(x.reads, 2);
  assert.equal(x.status().cacheHits, 0);
  assert.equal(x.status().nativeReads, 2);
});

test('cache mode reuses only element-scoped reads within the same 8ms scroll epoch', () => {
  const x = setup({ mode: 'cache' });
  x.scroll();
  assert.equal(x.scrollingElement.clientHeight, 500);
  x.scrollingElement.height = 600;
  assert.equal(x.scrollingElement.clientHeight, 500); // The documented stale-read risk.
  assert.equal(x.status().cacheHits, 1);
  x.scroll();
  assert.equal(x.scrollingElement.clientHeight, 600);
  assert.equal(x.reads, 2);
  x.scrollingElement.height = 700;
  x.advance(9);
  assert.equal(x.scrollingElement.clientHeight, 700);
  assert.equal(x.reads, 3);
});

test('no patch when DOM ownership check fails or native getter is missing', () => {
  const badOwner = setup({ mode: 'cache', turnInside: false });
  badOwner.scroll();
  assert.equal(badOwner.ownPatch, false);
  const missing = setup({ mode: 'cache', nativeGetter: false });
  missing.scroll();
  assert.equal(missing.ownPatch, false);
  assert.equal(missing.status().active, false);
});

test('does not replace existing per-element clientHeight property', () => {
  const x = setup({ mode: 'cache', ownGetter: true });
  x.scroll();
  assert.equal(x.scrollingElement.clientHeight, -1);
  assert.equal(x.status().patchedTargets, 0);
});

test('route exit and explicit restore remove exactly the own getter', () => {
  const x = setup({ mode: 'cache' });
  x.scroll();
  assert.equal(x.ownPatch, true);
  x.location.pathname = '/work';
  x.tick();
  assert.equal(x.ownPatch, false);
  x.location.pathname = '/c/back';
  x.scroll();
  assert.equal(x.ownPatch, true);
  x.window.ChatGPTRenderLitePhase4.restore();
  assert.equal(x.ownPatch, false);
  assert.equal(x.handlers.has('document:scroll'), false);
  assert.equal(x.status().active, false);
});

test('disconnected target is unpatched on periodic check', () => {
  const x = setup({ mode: 'observe' });
  x.scroll();
  x.scrollingElement.isConnected = false;
  x.tick();
  assert.equal(x.ownPatch, false);
  assert.equal(x.status().patchedTargets, 0);
});
