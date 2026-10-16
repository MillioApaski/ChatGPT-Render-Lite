'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const script = fs.readFileSync(path.join(__dirname, '..', 'chatgpt-render-lite.user.js'), 'utf8');
const marker = 'data-chatgpt-render-lite';

function createHarness({ enabled = false, count = 15, pathname = '/c/test-conversation', cssSupported = true } = {}) {
  const turns = Array.from({ length: count }, () => {
    const attributes = new Set();
    return {
      hasAttribute: (name) => attributes.has(name),
      toggleAttribute(name, force) { if (force) attributes.add(name); else attributes.delete(name); },
      removeAttribute: (name) => attributes.delete(name),
    };
  });
  const append = [];
  const scheduled = { timeout: [], interval: [] };
  const handlers = new Map();
  let menuCommand;
  let reloaded = false;
  let savedValue;
  const location = { pathname, reload() { reloaded = true; } };
  const document = {
    visibilityState: 'visible',
    head: { appendChild: (el) => append.push(el) },
    createElement() { return {}; },
    querySelectorAll(selector) {
      return selector === `[\${marker}]` ? turns.filter((turn) => turn.hasAttribute(marker)) : turns;
    },
    addEventListener(name, handler) { handlers.set(name, handler); },
  };
  vm.runInNewContext(script, {
    document,
    location,
    CSS: { supports: () => cssSupported },
    GM_getValue: () => enabled,
    GM_setValue: (_key, value) => { savedValue = value; },
    GM_registerMenuCommand: (_text, handler) => { menuCommand = handler; },
    setTimeout: (handler) => scheduled.timeout.push(handler),
    setInterval: (handler) => scheduled.interval.push(handler),
    console: { info() {}, warn() {} },
  });
  return {
    turns, append, scheduled, handlers, location, document,
    scan() { scheduled.timeout[0](); },
    countMarked() { return turns.filter((turn) => turn.hasAttribute(marker)).length; },
    toggle() { menuCommand(); },
    getSavedValue: () => savedValue,
    wasReloaded: () => reloaded,
  };
}

test('disabled mode injects nothing and has no periodic scan', () => {
  const h = createHarness();
  assert.equal(h.append.length, 0);
  assert.equal(h.scheduled.interval.length, 0);
  h.toggle();
  assert.equal(h.getSavedValue(), true);
  assert.equal(h.wasReloaded(), true);
});

test('enabled mode only marks old messages, keeping the latest six', () => {
  const h = createHarness({ enabled: true });
  h.scan();
  assert.equal(h.append.length, 1);
  assert.equal(h.countMarked(), 9);
  assert.equal(h.turns.slice(-6).every((x) => !x.hasAttribute(marker)), true);
});

test('short conversations are unchanged', () => {
  const h = createHarness({ enabled: true, count: 11 });
  h.scan();
  assert.equal(h.countMarked(), 0);
});

test('home/Work routes are unchanged, including SPA navigation', () => {
  const h = createHarness({ enabled: true });
  h.scan();
  assert.equal(h.countMarked(), 9);
  h.location.pathname = '/';
  h.scheduled.interval[0]();
  assert.equal(h.countMarked(), 0);
  h.location.pathname = '/work';
  h.scheduled.interval[0]();
  assert.equal(h.countMarked(), 0);
});

test('SPA transition into a conversation gets optimized', () => {
  const h = createHarness({ enabled: true, pathname: '/' });
  h.scan();
  assert.equal(h.countMarked(), 0);
  h.location.pathname = '/c/new-chat';
  h.scheduled.interval[0]();
  assert.equal(h.countMarked(), 9);
});

test('unsupported browser and disabled visibility skip DOM changes', () => {
  const unsupported = createHarness({ enabled: true, cssSupported: false });
  assert.equal(unsupported.append.length, 0);
  assert.equal(unsupported.scheduled.interval.length, 0);
  const hidden = createHarness({ enabled: true });
  hidden.document.visibilityState = 'hidden';
  hidden.scan();
  assert.equal(hidden.countMarked(), 0);
});
