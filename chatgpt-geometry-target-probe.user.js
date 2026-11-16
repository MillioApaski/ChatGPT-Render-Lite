// ==UserScript==
// @name         ChatGPT Render Lite - Geometry Target Probe (Phase 6.2)
// @namespace    https://github.com/MillioApaski/ChatGPT-Render-Lite
// @version      0.1.0
// @description  Manual, time-bounded geometry-read target investigation; read-only return values. OFF by default.
// @match        https://chatgpt.com/*
// @noframes
// @run-at       document-start
// @grant        none
// @sandbox      raw
// @homepageURL  https://github.com/MillioApaski/ChatGPT-Render-Lite
// @updateURL    https://raw.githubusercontent.com/MillioApaski/ChatGPT-Render-Lite/feature/phase6-native-render-bridge/chatgpt-geometry-target-probe.user.js
// @downloadURL  https://raw.githubusercontent.com/MillioApaski/ChatGPT-Render-Lite/feature/phase6-native-render-bridge/chatgpt-geometry-target-probe.user.js
// ==/UserScript==

(() => {
  'use strict';
  const API = 'ChatGPTRenderLiteGeometryProbe';
  if (Object.hasOwn(window, API)) return;

  // This tool intentionally does not intercept network requests, React state,
  // messages, or scrollend propagation. It NEVER caches/replaces DOMRect values.
  // While active, a temporary global method wrapper introduces measurement
  // overhead; DO NOT compare its timings to an uninstrumented performance trace.
  const MAX_DURATION_MS = 15000;
  const MAX_RECORDED_CALLS = 50000;
  const MAX_GROUPS = 32;
  const SCROLLEND_NEAR_MS = 200;
  const nativeDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'getBoundingClientRect');

  const state = {
    active: false,
    startAt: 0,
    lastScrollendAt: -Infinity,
    scrollendCount: 0,
    calls: 0,
    timedCalls: 0,
    nativeDurationMs: 0,
    maxNativeMs: 0,
    timer: null,
    routeWatch: null,
    path: '',
    groups: new Map(),
    reason: 'not-started',
    last: null,
    patched: false,
  };
  const routeIsConversation = () => /^\/(?:c|g)\//.test(location.pathname);
  const nearScrollend = now => (now - state.lastScrollendAt >= 0 &&
    now - state.lastScrollendAt <= SCROLLEND_NEAR_MS);
  function nodeGroup(element) {
    if (!(element instanceof Element)) return 'unknown';
    // Do not look at text, attributes' VALUES, React props, URLs or class names.
    const target = element.closest('[data-thread-frame-scrollbar]');
    if (element.matches('[data-thread-frame-scrollbar]')) return 'scroll-host';
    if (element.matches('[data-turn-key]')) return 'turn-root';
    if (element.matches('[data-dil-response]')) return 'dil-response-root';
    if (element.closest('[data-dil-response]')) return 'inside-dil';
    if (element.closest('[data-response-body]')) return 'inside-response';
    if (element.closest('[data-turn-key]')) return 'inside-turn';
    if (element.matches('[data-rail-chat-transcript]')) return 'transcript-root';
    if (element.closest('[data-rail-chat-transcript]')) return 'inside-transcript';
    if (target) return 'inside-scroll-host';
    return 'outside-transcript';
  }
  function track(element, nativeMs, near) {
    if (state.timedCalls >= MAX_RECORDED_CALLS) return;
    state.timedCalls++;
    state.nativeDurationMs += nativeMs;
    state.maxNativeMs = Math.max(state.maxNativeMs, nativeMs);
    const groupName = nodeGroup(element);
    const key = groupName + ' / ' + (near ? 'within-200ms-after-scrollend' : 'outside-window');
    let group = state.groups.get(key);
    if (!group) {
      if (state.groups.size >= MAX_GROUPS) return;
      group = { category: groupName, afterScrollend: near, calls: 0, nativeMs: 0, maxNativeMs: 0 };
      state.groups.set(key, group);
    }
    group.calls++;
    group.nativeMs += nativeMs;
    group.maxNativeMs = Math.max(group.maxNativeMs, nativeMs);
  }
  const original = nativeDescriptor?.value;
  function wrapped(...args) {
    if (!state.active) return Reflect.apply(original, this, args);
    // nativeMs includes native geometry computation, not style/layout
    // instrumentation overhead, but may include forced style/layout.
    const before = performance.now();
    try {
      return Reflect.apply(original, this, args);
    } finally {
      const elapsed = performance.now() - before;
      state.calls++;
      // Categorization intentionally takes place AFTER the native call.
      track(this, elapsed, nearScrollend(before));
    }
  }
  function listenScrollend() { state.scrollendCount++; state.lastScrollendAt = performance.now(); }
  function clean() {
    document.removeEventListener('scrollend', listenScrollend, true);
    window.removeEventListener('pagehide', onPageHide);
    document.removeEventListener('visibilitychange', onVisibility);
    if (state.timer !== null) clearTimeout(state.timer);
    if (state.routeWatch !== null) clearInterval(state.routeWatch);
    state.timer = null; state.routeWatch = null;
    const current = Object.getOwnPropertyDescriptor(Element.prototype, 'getBoundingClientRect');
    if (current?.value === wrapped && state.patched) {
      Object.defineProperty(Element.prototype, 'getBoundingClientRect', nativeDescriptor);
    }
    state.patched = false;
  }
  const round = n => Math.round(n * 1000) / 1000;
  function result(reason) {
    return {
      version: '0.1.0', reason, elapsedMs: Math.round(performance.now() - state.startAt),
      routeChanged: location.pathname !== state.path,
      calls: state.calls, sampledCalls: state.timedCalls,
      scrollendEvents: state.scrollendCount,
      nativeDurationMs: round(state.nativeDurationMs),
      maxSingleNativeMs: round(state.maxNativeMs),
      groups: [...state.groups.values()]
        .map(g => ({
          category: g.category, afterScrollend: g.afterScrollend,
          calls: g.calls, nativeMs: round(g.nativeMs), maxNativeMs: round(g.maxNativeMs)
        }))
        .sort((a,b) => b.nativeMs - a.nativeMs),
      warning: '此脚本临时包装全局 getBoundingClientRect；调用耗时受探针影响，不能直接当作改善基准；200ms 时间窗口只是相关性，不证明调用属于 scrollend 回调。',
      privacy: '未采集消息文本、ID 值、URL、DOMRect 或 React props'
    };
  }
  function restore(reason = 'manual') {
    if (!state.active) return state.last || { active: false, reason: state.reason };
    state.active = false;
    clean();
    state.reason = reason;
    state.last = result(reason);
    console.info('[RL Geometry Probe] finished', state.last);
    return state.last;
  }
  function onPageHide() { restore('pagehide'); }
  function onVisibility() { if (document.visibilityState === 'hidden') restore('hidden'); }
  function status() {
    return {
      version: '0.1.0', active: state.active, calls: state.calls,
      scrollendEvents: state.scrollendCount,
      lastReason: state.reason,
      hasNativeMethod: typeof original === 'function',
      last: state.last
    };
  }
  function capture(durationMs = 8000) {
    if (state.active) throw Error('已有探针正在运行；先执行 restore()');
    const duration = Number(durationMs);
    if (!Number.isFinite(duration) || duration < 1000 || duration > MAX_DURATION_MS)
      throw RangeError('仅支持 1000～15000ms');
    if (!routeIsConversation()) throw Error('仅在普通 ChatGPT 会话路由运行');
    if (document.visibilityState !== 'visible') throw Error('先切换到可见标签页');
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'getBoundingClientRect');
    if (!descriptor || descriptor.value !== original || descriptor.configurable !== true)
      throw Error('原生方法已被其他扩展修改或不可修改，拒绝执行');
    state.startAt = performance.now();
    state.lastScrollendAt = -Infinity;
    state.scrollendCount = 0;
    state.calls = 0; state.timedCalls = 0;
    state.nativeDurationMs = 0; state.maxNativeMs = 0;
    state.groups.clear();
    state.path = location.pathname;
    state.reason = 'running';
    state.last = null;
    // Wrapping is scoped to a bounded, explicit opt-in measurement window.
    Object.defineProperty(Element.prototype, 'getBoundingClientRect', {
      ...descriptor, value: wrapped
    });
    state.patched = true;
    state.active = true;
    document.addEventListener('scrollend', listenScrollend, { capture: true, passive: true });
    window.addEventListener('pagehide', onPageHide, { once: true });
    document.addEventListener('visibilitychange', onVisibility);
    state.timer = setTimeout(() => restore('completed'), duration);
    state.routeWatch = setInterval(() => {
      if (location.pathname !== state.path) restore('route-changed');
    }, 300);
    return {
      active: true, durationMs: duration,
      note: '现在正常手动向上滚动；到时自动恢复原生方法。不要用于性能 A/B 测试。'
    };
  }
  Object.defineProperty(window, API, {
    configurable: true, value: Object.freeze({ capture, restore, status })
  });
})();
