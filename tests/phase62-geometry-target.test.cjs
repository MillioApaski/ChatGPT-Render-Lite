const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const code = fs.readFileSync(path.resolve(__dirname,
  '../chatgpt-geometry-target-probe.user.js'), 'utf8');

function environment() {
  let now = 100;
  let scrollend;
  let visibility;
  let pagehide;
  const timers = new Map();
  let timerId = 0;

  class FakeElement {
    constructor(group = 'outside') { this.group = group; }
    getBoundingClientRect() { return { x: 3, width: 400 }; }
    closest(selector) {
      return selector === '[data-dil-response]' && this.group === 'dil'
        ? this
        : selector === '[data-turn-key]' && this.group === 'turn'
          ? this
          : selector === '[data-thread-frame-scrollbar]' && this.group === 'scroll'
            ? this
            : null;
    }
    matches(selector) {
      return selector === '[data-thread-frame-scrollbar]' && this.group === 'scroll'
        || selector === '[data-turn-key]' && this.group === 'turn'
        || selector === '[data-dil-response]' && this.group === 'dil';
    }
  }

  const window = {
    addEventListener(type, fn) { if (type === 'pagehide') pagehide = fn; },
    removeEventListener(type, fn) { if (type === 'pagehide' && pagehide === fn) pagehide = undefined; },
  };
  const document = {
    visibilityState: 'visible',
    addEventListener(type, fn) {
      if (type === 'scrollend') scrollend = fn;
      if (type === 'visibilitychange') visibility = fn;
    },
    removeEventListener(type, fn) {
      if (type === 'scrollend' && scrollend === fn) scrollend = undefined;
      if (type === 'visibilitychange' && visibility === fn) visibility = undefined;
    },
  };
  const location = { pathname: '/c/a' };
  const performance = { now: () => (now += 1) };
  const context = {
    window, document, location, performance, Element: FakeElement, Object,
    Reflect, Number, Map, Set, console: { info() {} },
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    setInterval(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    clearInterval(id) { timers.delete(id); },
  };
  vm.runInNewContext(code, context);
  return {
    api: window.ChatGPTRenderLiteGeometryProbe,
    window, document, location, FakeElement,
    getNative: () => FakeElement.prototype.getBoundingClientRect,
    fireScrollend: () => scrollend?.(),
    pagehide: () => pagehide?.(),
    visibility: () => visibility?.(),
    tick: () => { for (const [id, t] of [...timers]) if (t.ms >= 1000) { t.fn(); if (timers.has(id)) timers.delete(id); } },
  };
}

test('geometry probe defaults to fully inactive and never patches on registration', () => {
  const ctx = environment();
  const native = ctx.getNative();
  assert.equal(ctx.api.status().active, false);
  assert.equal(ctx.api.status().hasNativeMethod, true);
  assert.equal(ctx.getNative(), native);
});

test('opt-in capture returns original rect, aggregates categories and restores prototype', () => {
  const e = environment();
  const original = e.getNative();
  assert.equal(e.api.capture(3000).active, true);
  assert.notEqual(e.getNative(), original);
  const dil = new e.FakeElement('dil');
  const scroll = new e.FakeElement('scroll');
  assert.deepEqual(dil.getBoundingClientRect(), { x: 3, width: 400 });
  e.fireScrollend();
  assert.deepEqual(scroll.getBoundingClientRect(), { x: 3, width: 400 });
  const done = e.api.restore('manual');
  assert.equal(done.calls, 2);
  assert.equal(done.scrollendEvents, 1);
  assert.ok(done.groups.some(g => g.category === 'dil-response-root'));
  assert.ok(done.groups.some(g => g.category === 'scroll-host' && g.afterScrollend));
  assert.equal(e.getNative(), original);
  assert.equal(e.api.status().active, false);
  assert.ok(!JSON.stringify(done).includes('data-dil-message-id'));
});

test('invalid duration, route and repeated capture fail closed', () => {
  const e = environment();
  const original = e.getNative();
  assert.throws(() => e.api.capture(400), /仅支持/);
  e.location.pathname = '/';
  assert.throws(() => e.api.capture(3000), /仅在普通/);
  e.location.pathname = '/c/a';
  e.api.capture(3000);
  assert.throws(() => e.api.capture(2000), /已有探针/);
  e.pagehide();
  assert.equal(e.getNative(), original);
  assert.equal(e.api.status().last.reason, 'pagehide');
});

test('route transition or hidden tab automatically restores the original method', () => {
  const e = environment();
  const original = e.getNative();
  e.api.capture(3000);
  e.document.visibilityState = 'hidden';
  e.visibility();
  assert.equal(e.getNative(), original);
  assert.equal(e.api.status().lastReason, 'hidden');
  e.document.visibilityState = 'visible';
  e.api.capture(3000);
  e.location.pathname = '/c/b';
  e.tick();
  assert.equal(e.getNative(), original);
  assert.equal(e.api.status().lastReason, 'route-changed');
});

test('other prototype replacement is not overwritten by cleanup', () => {
  const e = environment();
  e.api.capture(3000);
  const other = function() { return { width: 0 }; };
  e.FakeElement.prototype.getBoundingClientRect = other;
  e.api.restore();
  assert.equal(e.getNative(), other);
});
