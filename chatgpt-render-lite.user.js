// ==UserScript==
// @name         ChatGPT Render Lite (Experimental)
// @namespace    https://github.com/MillioApaski/ChatGPT-Render-Lite
// @version      0.2.0
// @description  Opt-in offscreen rendering experiment for long ChatGPT conversations. Easy to disable; no internal function patching.
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

  // This is an A/B experiment, not a patch for ChatGPT's internal JavaScript.
  // It may change offscreen size estimates, scroll anchoring, or find-in-page behavior.
  const STORAGE_KEY = 'chatgpt-render-lite-enabled-v1';
  const MARKER = 'data-chatgpt-render-lite';
  const TURN_SELECTOR = '[data-testid^="conversation-turn-"]';
  const MIN_TURNS = 12;
  const KEEP_LATEST = 6;
  const SCAN_INTERVAL_MS = 5000;
  const STYLE_ID = 'chatgpt-render-lite-style';
  const enabled = Boolean(GM_getValue(STORAGE_KEY, false));

  GM_registerMenuCommand(
    `ChatGPT Render Lite: ${enabled ? '关闭优化' : '开启优化'}（刷新页面后生效）`,
    () => {
      GM_setValue(STORAGE_KEY, !enabled);
      location.reload();
    }
  );

  // Disabled means no CSS injection, DOM scan or recurring timer.
  if (!enabled) return;

  if (!CSS.supports('content-visibility', 'auto') ||
      !CSS.supports('contain-intrinsic-block-size', 'auto 500px')) {
    console.warn('[Render Lite] Browser does not support the required CSS properties.');
    return;
  }

  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    [${MARKER}] {
      content-visibility: auto;
      contain-intrinsic-block-size: auto 500px;
    }
  `;
  (document.head || document.documentElement).appendChild(style);

  let previousPath = '';
  let previousTurnCount = -1;
  let previousMarkedCount = -1;

  function isConversationPath(path) {
    // Run on chatgpt.com/* so SPA navigation from the home screen also works.
    // Do not modify Work or unrelated ChatGPT pages.
    return /^\/(?:c\/[^/]+|g\/[^/]+\/c\/[^/]+)(?:\/|$)/.test(path);
  }

  function scan() {
    if (document.visibilityState !== 'visible') return;

    const path = location.pathname;
    if (!isConversationPath(path)) {
      // A client-side route transition can reuse DOM nodes briefly.
      if (previousMarkedCount > 0) {
        for (const el of document.querySelectorAll(`[${MARKER}]`)) {
          el.removeAttribute(MARKER);
        }
      }
      previousPath = path;
      previousTurnCount = 0;
      previousMarkedCount = 0;
      return;
    }

    const turns = document.querySelectorAll(TURN_SELECTOR);
    const eligibleCount = turns.length >= MIN_TURNS
      ? Math.max(0, turns.length - KEEP_LATEST)
      : 0;

    // No synchronous layout reads, no scroll/mousemove listeners, no
    // monkey-patching of clientHeight/getBoundingClientRect or React internals.
    for (let i = 0; i < turns.length; i++) {
      const shouldMark = i < eligibleCount;
      const isMarked = turns[i].hasAttribute(MARKER);
      if (shouldMark !== isMarked) turns[i].toggleAttribute(MARKER, shouldMark);
    }

    if (path !== previousPath || turns.length !== previousTurnCount ||
        eligibleCount !== previousMarkedCount) {
      console.info(`[Render Lite] ${turns.length} turns found, ${eligibleCount} older turns eligible.`);
      previousPath = path;
      previousTurnCount = turns.length;
      previousMarkedCount = eligibleCount;
    }
  }

  setTimeout(scan, 1200);
  setInterval(scan, SCAN_INTERVAL_MS);
  document.addEventListener('visibilitychange', scan);
})();
