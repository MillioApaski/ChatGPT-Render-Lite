'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'chatgpt-render-lite.user.js'), 'utf8');
const MARKER = 'data-chatgpt-render-lite';

function harness({ count = 15, enabled = true, mode = 'viewport-guard', observerAvailable = true } = {}) {
  let now = 10000;
  let reloaded = false;
  const saved = [];
  const callbacks = new Map();
  const timers = [];
  const intervals = [];
  const menus = [];
  const turns = Array.from({ length: count }, () => {
    const attrs = new Set();
    return {
      hasAttribute: (key) => attrs.has(key),
      toggleAttribute(key, set) { if (set) attrs.add(key); else attrs.delete(key); },
      removeAttribute: (key) => attrs.delete(key),
    };
  });
  const document = {
    head: { appendChild() {} },
    visibilityState: 'visible',
    createElement() { return {}; },
    addEventListener(type, cb) { callbacks.set(type, cb); },
    querySelectorAll(selector) {
      if (selector === '[' + MARKER + ']') return turns.filter((t) => t.hasAttribute(MARKER));
      if (selector === '[data-testid^="conversation-turn-"]') return turns;
      throw new Error('Unexpected selector: ' + selector);
    },
  };
  const location = { pathname: '/c/test', reload() { reloaded = true; } };
  let observer = null;
  class FakeIntersectionObserver {
    constructor(callback, options) {
      this.callback = callback;
      this.options = options;
      this.targets = new Set();
      observer = this;
    }
    observe(target) { this.targets.add(target); }
    unobserve(target) { this.targets.delete(target); }
    emit(entries) { this.callback(entries.map(([index, isIntersecting]) => ({
      target: turns[index], isIntersecting,
    }))); }
  }
  const context = {
    document, location,
    CSS: { supports: () => true },
    GM_getValue: (name, fallback) =>
      name.endsWith('enabled-v1') ? enabled :
      name.endsWith('mode-v3') ? mode : fallback,
    GM_setValue: (key, val) => saved.push([key, val]),
    GM_registerMenuCommand: (label, fn) => menus.push({ label, fn }),
    setTimeout: (fn, delay) => { timers.push({ fn, delay }); return timers.length; },
    setInterval: (fn) => { intervals.push(fn); },
    Date: class extends Date { static now() { return now; } },
    console: { warn() {}, info() {} },
  };
  if (observerAvailable) context.IntersectionObserver = FakeIntersectionObserver;
  vm.runInNewContext(source, context, { timeout: 1000 });

  return {
    turns, saved, menus, callbacks, intervals, document, location,
    get observer() { return observer; },
    get reloaded() { return reloaded; },
    tick(ms = 0) { now += ms; assert.ok(timers.length, 'Expected a timer'); timers.shift().fn(); },
    pendingTimers() { return timers.length; },
    rescan() { assert.ok(intervals.length); intervals[0](); },
    marked() { return turns.map((turn, i) => turn.hasAttribute(MARKER) ? i : -1).filter((i) => i >= 0); },
    switchMode() { menus.find((x) => x.label.startsWith('Render Lite 模式:')).fn(); },
  };
}

test('guard protects unknown turns until first IntersectionObserver result', () => {
  const h = harness();
  h.tick();
  assert.equal(h.observer.targets.size, 9);
  h.tick();
  assert.deepEqual(h.marked(), []);
});

test('guard excludes near viewport and adjacent turns; never marks latest six', () => {
  const h = harness();
  h.tick();
  h.observer.emit(Array.from({ length: 9 }, (_, i) => [i, i === 4]));
  h.tick();
  assert.deepEqual(h.marked(), [0, 1, 2, 6, 7, 8]);
  assert.deepEqual(h.observer.options.rootMargin, '900px 0px 900px 0px');
});

test('guard does not modify style until scrolling has been quiet', () => {
  const h = harness();
  h.tick();
  h.observer.emit(Array.from({ length: 9 }, (_, i) => [i, false]));
  h.callbacks.get('scroll')();
  h.tick(100);
  assert.deepEqual(h.marked(), []);
  assert.equal(h.pendingTimers(), 1);
  h.tick(250);
  assert.equal(h.marked().length, 9);
});

test('SPA route exit clears both containment marks and subscriptions', () => {
  const h = harness();
  h.tick();
  h.observer.emit(Array.from({ length: 9 }, (_, i) => [i, false]));
  h.tick();
  assert.equal(h.marked().length, 9);
  h.location.pathname = '/work';
  h.rescan();
  assert.deepEqual(h.marked(), []);
  assert.equal(h.observer.targets.size, 0);
});

test('guard limits style writes per pass to 24', () => {
  const h = harness({ count: 60 });
  h.tick();
  h.observer.emit(Array.from({ length: 54 }, (_, i) => [i, false]));
  h.tick();
  assert.equal(h.marked().length, 24);
  h.tick();
  assert.equal(h.marked().length, 48);
  h.tick();
  assert.equal(h.marked().length, 54);
});

test('without IntersectionObserver guard falls back to classic', () => {
  const h = harness({ observerAvailable: false });
  h.tick();
  assert.deepEqual(h.marked(), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
});

test('mode menu changes only mode setting and reloads', () => {
  const h = harness();
  h.switchMode();
  assert.deepEqual(h.saved, [['chatgpt-render-lite-mode-v3', 'classic']]);
  assert.equal(h.reloaded, true);
});

test('disabled mode retains menus but never schedules work', () => {
  const h = harness({ enabled: false });
  assert.equal(h.pendingTimers(), 0);
  assert.equal(h.callbacks.size, 0);
  assert.equal(h.observer, null);
});
