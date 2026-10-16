// ==UserScript==
// @name         ChatGPT Render Lite - Geometry Cache (Phase 4 Experimental)
// @namespace    https://github.com/MillioApaski/ChatGPT-Render-Lite
// @version      0.1.0
// @description  Opt-in, element-scoped clientHeight instrumentation and short-lived cache. EXPERIMENTAL.
// @match        https://chatgpt.com/*
// @noframes
// @run-at       document-start
// @grant        none
// @sandbox      raw
// @homepageURL  https://github.com/MillioApaski/ChatGPT-Render-Lite
// @supportURL   https://github.com/MillioApaski/ChatGPT-Render-Lite/issues
// @updateURL    https://raw.githubusercontent.com/MillioApaski/ChatGPT-Render-Lite/main/chatgpt-geometry-cache.user.js
// @downloadURL  https://raw.githubusercontent.com/MillioApaski/ChatGPT-Render-Lite/main/chatgpt-geometry-cache.user.js
// ==/UserScript==

(() => {
  'use strict';

  // Deliberately a separate, MAIN_WORLD userscript: the stable v0.3 Render Lite
  // installation is unaffected. No global prototype getter is replaced.
  const KEY = 'chatgpt-render-lite:phase4:mode';
  const MODES = new Set(['off', 'observe', 'cache']);
  const CACHE_TTL_MS = 8;
  const MAX_TARGETS = 2;
  const MAX_REUSES_PER_EPOCH = 2;
  const RETRY_REJECTED_TARGET_MS = 2000;
  const TURN_SELECTOR = '[data-testid^="conversation-turn-"]';
  const nativeHeight = Object.getOwnPropertyDescriptor(Element.prototype, 'clientHeight')?.get;

  const state = {
    mode: 'off',
    active: false,
    candidates: 0,
    patched: 0,
    nativeReads: 0,
    cacheHits: 0,
    nativeReadTimeMs: 0,
    maxNativeReadMs: 0,
    failures: 0,
    scrollEvents: 0,
    epoch: 0,
  };
  const patched = new Map();
  const rejected = new WeakMap();
  let routeTimer = null;

  function isConversation(pathname) {
    return /^\/(?:c\/[^/]+|g\/[^/]+\/c\/[^/]+)(?:\/|$)/.test(pathname);
  }

  function savedMode() {
    try {
      const value = localStorage.getItem(KEY);
      return MODES.has(value) ? value : 'off';
    } catch {
      return 'off';
    }
  }

  function getStatus() {
    return Object.freeze({
      mode: state.mode,
      active: state.active,
      candidates: state.candidates,
      patchedTargets: patched.size,
      nativeReads: state.nativeReads,
      cacheHits: state.cacheHits,
      hitRate: state.nativeReads + state.cacheHits === 0
        ? 0 : state.cacheHits / (state.nativeReads + state.cacheHits),
      nativeReadTimeMs: Math.round(state.nativeReadTimeMs * 100) / 100,
      maxNativeReadMs: Math.round(state.maxNativeReadMs * 100) / 100,
      failures: state.failures,
      scrollEvents: state.scrollEvents,
      requestedWorld: 'MAIN_WORLD',
      note: 'Native timings include measurement overhead. Cached reads may return stale heights.',
    });
  }

  function restoreTargets() {
    for (const [element, entry] of patched) {
      try {
        if (Object.getOwnPropertyDescriptor(element, 'clientHeight')?.get === entry.getter) {
          delete element.clientHeight;
        }
      } catch {
        state.failures++;
      }
    }
    patched.clear();
  }

  function stop() {
    state.active = false;
    document.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('pagehide', stop);
    if (routeTimer !== null) clearInterval(routeTimer);
    routeTimer = null;
    restoreTargets();
  }

  function setMode(mode) {
    if (!MODES.has(mode)) throw new TypeError('Mode must be off, observe, or cache');
    try {
      localStorage.setItem(KEY, mode);
    } catch {
      throw new Error('Storage unavailable; cannot persist Phase 4 mode');
    }
    location.reload();
  }

  // Provide a small API before any hooks are installed. This makes it possible
  // to opt in from the console without user-script privileges or a page overlay.
  Object.defineProperty(window, 'ChatGPTRenderLitePhase4', {
    configurable: true,
    value: Object.freeze({ status: getStatus, setMode, restore: stop }),
  });

  state.mode = savedMode();
  if (state.mode === 'off') return;
  if (typeof nativeHeight !== 'function') {
    console.warn('[Render Lite Phase 4] native clientHeight getter not found. No patch installed.');
    return;
  }

  function maybePatch(element) {
    if (!state.active || patched.has(element) || patched.size >= MAX_TARGETS) return;
    if (!(element instanceof HTMLElement) || Object.hasOwn(element, 'clientHeight')) return;

    // Only an actual scrolling element containing ChatGPT messages is eligible.
    // Never patch window/document or the global Element/HTMLElement prototype.
    const lastRejected = rejected.get(element);
    const now = performance.now();
    if (typeof lastRejected === 'number' &&
        now - lastRejected < RETRY_REJECTED_TARGET_MS) return;
    const turn = document.querySelector(TURN_SELECTOR);
    if (!turn || !element.contains(turn)) {
      rejected.set(element, now);
      return;
    }

    state.candidates++;
    const cache = { epoch: -1, time: 0, value: 0, uses: 0 };
    const getter = function () {
      // The own getter only exists on this element. Other clientHeight reads
      // retain native behavior, and every new scroll event invalidates cache.
      const time = performance.now();
      if (state.active && state.mode === 'cache' &&
          document.visibilityState === 'visible' &&
          cache.epoch === state.epoch && cache.uses < MAX_REUSES_PER_EPOCH &&
          time - cache.time >= 0 && time - cache.time <= CACHE_TTL_MS) {
        state.cacheHits++;
        cache.uses++;
        return cache.value;
      }
      const started = performance.now();
      const value = nativeHeight.call(this);
      const elapsed = performance.now() - started;
      state.nativeReads++;
      state.nativeReadTimeMs += elapsed;
      state.maxNativeReadMs = Math.max(state.maxNativeReadMs, elapsed);
      cache.value = value;
      cache.time = performance.now();
      cache.epoch = state.epoch;
      cache.uses = 0;
      return value;
    };

    try {
      Object.defineProperty(element, 'clientHeight', {
        configurable: true, enumerable: false, get: getter,
      });
      patched.set(element, { getter });
      state.patched++;
    } catch {
      state.failures++;
    }
  }

  function onScroll(event) {
    if (!state.active) return;
    state.scrollEvents++;
    state.epoch++;
    if (!isConversation(location.pathname)) {
      restoreTargets();
      return;
    }
    let element = event.target;
    if (element === document) element = document.scrollingElement;
    if (!(element instanceof HTMLElement)) return;
    maybePatch(element);
  }

  state.active = true;
  document.addEventListener('scroll', onScroll, { capture: true, passive: true });
  window.addEventListener('pagehide', stop);
  routeTimer = setInterval(() => {
    if (!isConversation(location.pathname)) restoreTargets();
    for (const element of patched.keys()) {
      if (!element.isConnected) {
        const entry = patched.get(element);
        try {
          if (Object.getOwnPropertyDescriptor(element, 'clientHeight')?.get === entry.getter) {
            delete element.clientHeight;
          }
        } catch { state.failures++; }
        patched.delete(element);
      }
    }
  }, 2000);
})();