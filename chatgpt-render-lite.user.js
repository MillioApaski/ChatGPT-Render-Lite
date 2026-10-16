// ==UserScript==
// @name         ChatGPT Render Lite (Experimental)
// @namespace    https://github.com/MillioApaski/ChatGPT-Render-Lite
// @version      0.3.0
// @description  Opt-in offscreen rendering with an experimental viewport guard for ChatGPT long conversations.
// @match        https://chatgpt.com/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @homepageURL  https://github.com/MillioApaski/ChatGPT-Render-Lite
// @supportURL   https://github.com/MillioApaski/ChatGPT-Render-Lite/issues
// @updateURL    https://raw.githubusercontent.com/MillioApaski/ChatGPT-Render-Lite/main/chatgpt-render-lite.user.js
// @downloadURL  https://raw.githubusercontent.com/MillioApaski/ChatGPT-Render-Lite/main/chatgpt-render-lite.user.js
// ==/UserScript==

(() => {
  'use strict';

  // All modes are experiments. Never patch ChatGPT functions or geometry getters.
  const ENABLED_KEY = 'chatgpt-render-lite-enabled-v1'; // Keep v0.2 user preference.
  const MODE_KEY = 'chatgpt-render-lite-mode-v3';
  const CLASSIC = 'classic';
  const VIEWPORT_GUARD = 'viewport-guard';
  const MARKER = 'data-chatgpt-render-lite';
  const TURN_SELECTOR = '[data-testid^="conversation-turn-"]';
  const MIN_TURNS = 12;
  const KEEP_LATEST = 6;
  const SCAN_INTERVAL_MS = 5000;
  const GUARD_MARGIN = '900px 0px 900px 0px';
  const SCROLL_QUIET_MS = 220;
  const APPLY_DELAY_MS = 240;
  const MAX_MARK_CHANGES = 24;

  const enabled = GM_getValue(ENABLED_KEY, false) === true;
  const storedMode = GM_getValue(MODE_KEY, CLASSIC);
  const mode = storedMode === VIEWPORT_GUARD ? VIEWPORT_GUARD : CLASSIC;

  GM_registerMenuCommand(
    'ChatGPT Render Lite: ' + (enabled ? '关闭优化' : '开启优化') + '（刷新生效）',
    () => {
      GM_setValue(ENABLED_KEY, !enabled);
      location.reload();
    }
  );
  GM_registerMenuCommand(
    'Render Lite 模式: ' + (mode === CLASSIC ? '经典模式' : 'Viewport Guard 实验') + '（点击切换）',
    () => {
      GM_setValue(MODE_KEY, mode === CLASSIC ? VIEWPORT_GUARD : CLASSIC);
      location.reload();
    }
  );

  // When disabled there are no observers, listeners, CSS, or recurring scans.
  if (!enabled) return;

  if (!CSS.supports('content-visibility', 'auto') ||
      !CSS.supports('contain-intrinsic-block-size', 'auto 500px')) {
    console.warn('[Render Lite] Required CSS features are unavailable.');
    return;
  }

  const style = document.createElement('style');
  style.id = 'chatgpt-render-lite-style';
  style.textContent = '[' + MARKER + ']{content-visibility:auto;contain-intrinsic-block-size:auto 500px;}';
  (document.head || document.documentElement).appendChild(style);

  const guardEnabled = mode === VIEWPORT_GUARD && typeof IntersectionObserver === 'function';
  if (mode === VIEWPORT_GUARD && !guardEnabled) {
    console.warn('[Render Lite] IntersectionObserver unavailable; using classic behavior.');
  }

  let previousPath = '';
  let previousTurnCount = -1;
  let previousEligibleCount = -1;
  let currentTurns = [];
  let eligibleCount = 0;
  let lastScrollAt = 0;
  let guardTimer = null;

  const observed = new Set();
  // undefined = no IntersectionObserver report yet: fail open, no containment.
  const intersectionState = new Map();

  function isConversationPath(path) {
    return /^\/(?:c\/[^/]+|g\/[^/]+\/c\/[^/]+)(?:\/|$)/.test(path);
  }

  function setMarked(turn, shouldMark) {
    if (turn.hasAttribute(MARKER) !== shouldMark) {
      turn.toggleAttribute(MARKER, shouldMark);
      return true;
    }
    return false;
  }

  function clearMarks() {
    for (const el of document.querySelectorAll('[' + MARKER + ']')) {
      el.removeAttribute(MARKER);
    }
  }

  function scheduleGuardApply() {
    if (guardTimer !== null) return;
    guardTimer = setTimeout(applyGuard, APPLY_DELAY_MS);
  }

  function applyGuard() {
    guardTimer = null;
    if (!guardEnabled || document.visibilityState !== 'visible' ||
        !isConversationPath(location.pathname)) return;

    // CSS writes during scroll could dirty style immediately before
    // ChatGPT's reconcileViewport/clientHeight path. Defer our own writes.
    if (Date.now() - lastScrollAt < SCROLL_QUIET_MS) {
      scheduleGuardApply();
      return;
    }

    const protectedIndexes = new Set();
    for (let i = 0; i < eligibleCount; i++) {
      const near = intersectionState.get(currentTurns[i]);
      if (near !== false) {
        // Always keep the near-viewport turn and one adjacent turn each side
        // unconstrained. The last six turns are never contained in any mode.
        for (let j = Math.max(0, i - 1); j <= Math.min(currentTurns.length - 1, i + 1); j++) {
          protectedIndexes.add(j);
        }
      }
    }

    let changes = 0;
    for (let i = 0; i < currentTurns.length; i++) {
      const shouldMark = i < eligibleCount && !protectedIndexes.has(i);
      if (setMarked(currentTurns[i], shouldMark)) {
        changes++;
        if (changes === MAX_MARK_CHANGES) {
          scheduleGuardApply();
          break;
        }
      }
    }
  }

  const observer = guardEnabled
    ? new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (observed.has(entry.target)) {
            intersectionState.set(entry.target, entry.isIntersecting);
          }
        }
        scheduleGuardApply();
      }, { root: null, rootMargin: GUARD_MARGIN, threshold: 0 })
    : null;

  function resetRoute() {
    if (observer) {
      for (const el of observed) observer.unobserve(el);
      observed.clear();
      intersectionState.clear();
      currentTurns = [];
      eligibleCount = 0;
    }
    clearMarks();
    previousTurnCount = 0;
    previousEligibleCount = 0;
  }

  function scan() {
    if (document.visibilityState !== 'visible') return;
    const path = location.pathname;
    if (!isConversationPath(path)) {
      if (previousPath !== path || previousEligibleCount > 0) resetRoute();
      previousPath = path;
      return;
    }

    const turns = Array.from(document.querySelectorAll(TURN_SELECTOR));
    const nextEligibleCount = turns.length >= MIN_TURNS
      ? Math.max(0, turns.length - KEEP_LATEST) : 0;

    if (!guardEnabled) {
      for (let i = 0; i < turns.length; i++) {
        setMarked(turns[i], i < nextEligibleCount);
      }
    } else {
      currentTurns = turns;
      eligibleCount = nextEligibleCount;
      const next = new Set(turns.slice(0, eligibleCount));
      for (const el of observed) {
        if (!next.has(el)) {
          observer.unobserve(el);
          observed.delete(el);
          intersectionState.delete(el);
        }
      }
      for (const el of next) {
        if (!observed.has(el)) {
          observed.add(el);
          observer.observe(el);
        }
      }
      // Immediately release no-longer-eligible turns (including latest six).
      for (let i = eligibleCount; i < turns.length; i++) setMarked(turns[i], false);
      scheduleGuardApply();
    }

    if (path !== previousPath || turns.length !== previousTurnCount ||
        nextEligibleCount !== previousEligibleCount) {
      console.info('[Render Lite] mode=' + (guardEnabled ? VIEWPORT_GUARD : CLASSIC) +
        ', turns=' + turns.length + ', eligible=' + nextEligibleCount);
      previousPath = path;
      previousTurnCount = turns.length;
      previousEligibleCount = nextEligibleCount;
    }
  }

  if (guardEnabled) {
    document.addEventListener('scroll', () => {
      lastScrollAt = Date.now();
    }, { capture: true, passive: true });
  }

  setTimeout(scan, 1200);
  setInterval(scan, SCAN_INTERVAL_MS);
  document.addEventListener('visibilitychange', scan);
})();