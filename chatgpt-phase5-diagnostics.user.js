// ==UserScript==
// @name         ChatGPT Render Lite - Phase 5 Diagnostics
// @namespace    https://github.com/MillioApaski/ChatGPT-Render-Lite
// @version      0.1.0
// @description  Opt-in, read-only browser performance sampling for ChatGPT. No hooks or network requests.
// @match        https://chatgpt.com/*
// @noframes
// @run-at       document-idle
// @grant        GM_registerMenuCommand
// @homepageURL  https://github.com/MillioApaski/ChatGPT-Render-Lite
// @supportURL   https://github.com/MillioApaski/ChatGPT-Render-Lite/issues
// @updateURL    https://raw.githubusercontent.com/MillioApaski/ChatGPT-Render-Lite/main/chatgpt-phase5-diagnostics.user.js
// @downloadURL  https://raw.githubusercontent.com/MillioApaski/ChatGPT-Render-Lite/main/chatgpt-phase5-diagnostics.user.js
// ==/UserScript==

(() => {
  'use strict';

  // Phase 5 is separate from the optimization scripts, and disabled until
  // explicitly started. No React access, DOM mutation, API patching, or uploads.
  const VERSION = '0.1.0';
  const MAX_RECORDS = 600;
  const MAX_SCRIPTS_PER_FRAME = 4;
  const TOP_SCRIPTS = 12;
  const TURN_SELECTOR = '[data-testid^="conversation-turn-"]';
  const supported = new Set(
    typeof PerformanceObserver === 'function'
      ? (PerformanceObserver.supportedEntryTypes || []) : []
  );

  let session = null;
  let observers = [];
  let sampleTimer = null;

  const number = (value) =>
    typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 100) / 100 : null;

  // Keep only filenames/origins, never URLs with query strings, fragments,
  // conversation ids, prompts, messages, or input content.
  function safeSource(value) {
    if (!value || typeof value !== 'string') return '';
    try {
      const u = new URL(value, location.origin);
      return u.protocol === 'https:' || u.protocol === 'http:'
        ? u.origin + u.pathname.slice(0, 180) : '';
    } catch {
      return '';
    }
  }

  function pushBounded(list, item) {
    if (list.length >= MAX_RECORDS) list.shift();
    list.push(item);
  }

  function countTurns() {
    return document.querySelectorAll(TURN_SELECTOR).length;
  }

  function snapshot() {
    return {
      atMs: number(performance.now()),
      turns: countTurns(),
      domNodes: document.getElementsByTagName('*').length,
      jsHeapUsedBytes: number(performance.memory?.usedJSHeapSize),
      documentVisibility: document.visibilityState,
    };
  }

  function observe(type, callback, options = {}) {
    if (!supported.has(type)) return false;
    try {
      const observer = new PerformanceObserver((list) => {
        if (!session?.running) return;
        for (const entry of list.getEntries()) callback(entry);
      });
      observer.observe({ type, buffered: false, ...options });
      observers.push(observer);
      return true;
    } catch (err) {
      console.warn('[Render Lite Phase 5] Observer unavailable:', type, err);
      return false;
    }
  }

  function recordLoaf(entry) {
    session.totalLoafCount++;
    const scripts = Array.from(entry.scripts || [])
      .map((s) => ({
        durationMs: number(s.duration),
        forcedStyleAndLayoutMs: number(s.forcedStyleAndLayoutDuration),
        forcedStyleMs: number(s.forcedStyleDuration),
        forcedLayoutMs: number(s.forcedLayoutDuration),
        source: safeSource(s.sourceURL),
        functionName: String(s.sourceFunctionName || '').slice(0, 100),
        invokerType: String(s.invokerType || '').slice(0, 50),
      }))
      .sort((a, b) => (b.durationMs || 0) - (a.durationMs || 0))
      .slice(0, MAX_SCRIPTS_PER_FRAME);

    pushBounded(session.loafs, {
      startMs: number(entry.startTime),
      durationMs: number(entry.duration),
      renderStartMs: number(entry.renderStart),
      styleAndLayoutStartMs: number(entry.styleAndLayoutStart),
      // New timing fields are browser-version dependent; null means unknown.
      styleMs: number(entry.styleDuration),
      layoutMs: number(entry.layoutDuration),
      endOfFrameStyleAndLayoutMs:
        typeof entry.styleAndLayoutStart === 'number' && entry.styleAndLayoutStart > 0
          ? number(Math.max(0, entry.startTime + entry.duration - entry.styleAndLayoutStart))
          : null,
      scripts,
    });
  }

  function recordEvent(entry) {
    session.totalEventCount++;
    // Event Timing is thresholded and does not report every interaction.
    // This measures the individual reported event, NOT a standards-compliant INP.
    pushBounded(session.events, {
      startMs: number(entry.startTime),
      durationMs: number(entry.duration),
      name: String(entry.name || '').slice(0, 50),
      interactionId: typeof entry.interactionId === 'number' ? entry.interactionId : null,
      inputDelayMs: number(Math.max(0, entry.processingStart - entry.startTime)),
      processingMs: number(Math.max(0, entry.processingEnd - entry.processingStart)),
      presentationDelayMs: number(Math.max(0,
        entry.startTime + entry.duration - entry.processingEnd)),
    });
  }

  function recordTask(entry) {
    session.totalLongTaskCount++;
    pushBounded(session.longTasks, {
      startMs: number(entry.startTime),
      durationMs: number(entry.duration),
      name: String(entry.name || '').slice(0, 50),
    });
  }

  function start() {
    if (session?.running) {
      console.info('[Render Lite Phase 5] Already recording.');
      return;
    }
    if (!supported.size) {
      console.warn('[Render Lite Phase 5] PerformanceObserver unavailable.');
      return;
    }

    session = {
      version: VERSION,
      startedAt: new Date().toISOString(),
      startedMs: number(performance.now()),
      running: true,
      support: {
        longAnimationFrame: false, longTask: false, eventTiming: false,
      },
      totalLoafCount: 0,
      totalLongTaskCount: 0,
      totalEventCount: 0,
      loafs: [],
      longTasks: [],
      events: [],
      turnSamples: [],
      startSnapshot: null,
      endSnapshot: null,
    };
    // Snapshot is isolated outside of the PerformanceObserver callback.
    session.startSnapshot = snapshot();
    session.support.longAnimationFrame = observe('long-animation-frame', recordLoaf);
    session.support.longTask = observe('longtask', recordTask);
    session.support.eventTiming = observe('event', recordEvent, { durationThreshold: 40 });
    sampleTimer = setInterval(() => {
      if (!session?.running || document.visibilityState !== 'visible') return;
      // Sample conversation size only; do not walk the whole DOM every interval.
      pushBounded(session.turnSamples, {
        atMs: number(performance.now()),
        turns: countTurns(),
      });
    }, 5000);
    console.info('[Render Lite Phase 5] Recording started. Reproduce the stutter, then stop and export via Tampermonkey menu.');
  }

  function stop() {
    if (!session?.running) return;
    // Stop observation BEFORE taking the potentially costly final DOM snapshot.
    session.running = false;
    for (const o of observers) o.disconnect();
    observers = [];
    clearInterval(sampleTimer);
    sampleTimer = null;
    session.stoppedAt = new Date().toISOString();
    session.stoppedMs = number(performance.now());
    session.endSnapshot = snapshot();
    console.info('[Render Lite Phase 5] Stopped.', summarize(session));
  }

  function percentile(values, p) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return number(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)]);
  }

  function summarize(s) {
    const loafDurations = s.loafs.map((x) => x.durationMs).filter((x) => x !== null);
    const taskDurations = s.longTasks.map((x) => x.durationMs).filter((x) => x !== null);
    const eventDurations = s.events.map((x) => x.durationMs).filter((x) => x !== null);
    const sourceMap = new Map();
    for (const loaf of s.loafs) {
      for (const script of loaf.scripts) {
        const key = script.source || '(unknown)';
        const row = sourceMap.get(key) || { source: key, sampledScriptMs: 0, forcedStyleAndLayoutMs: 0, samples: 0 };
        row.sampledScriptMs += script.durationMs || 0;
        row.forcedStyleAndLayoutMs += script.forcedStyleAndLayoutMs || 0;
        row.samples++;
        sourceMap.set(key, row);
      }
    }
    const topSources = [...sourceMap.values()]
      .sort((a, b) => b.sampledScriptMs - a.sampledScriptMs)
      .slice(0, TOP_SCRIPTS)
      .map((x) => ({
        ...x,
        sampledScriptMs: number(x.sampledScriptMs),
        forcedStyleAndLayoutMs: number(x.forcedStyleAndLayoutMs),
      }));

    return {
      durationSec: number(((s.stoppedMs ?? performance.now()) - s.startedMs) / 1000),
      support: s.support,
      sampleLimitPerType: MAX_RECORDS,
      totalLoafCount: s.totalLoafCount,
      retainedLoafCount: s.loafs.length,
      loafP95Ms: percentile(loafDurations, 0.95),
      loafMaxMs: loafDurations.length ? Math.max(...loafDurations) : null,
      totalLongTaskCount: s.totalLongTaskCount,
      retainedLongTaskCount: s.longTasks.length,
      longTaskP95Ms: percentile(taskDurations, 0.95),
      longTaskMaxMs: taskDurations.length ? Math.max(...taskDurations) : null,
      totalThresholdedEventCount: s.totalEventCount,
      retainedEventCount: s.events.length,
      thresholdedEventP95Ms: percentile(eventDurations, 0.95),
      worstEvent: [...s.events].sort((a, b) => (b.durationMs || 0) - (a.durationMs || 0))[0] || null,
      topScriptSourcesFromRetainedLoafFrames: topSources,
    };
  }

  function exportJson() {
    if (!session) {
      console.warn('[Render Lite Phase 5] Start a recording first.');
      return;
    }
    if (session.running) stop();
    const payload = {
      note: 'Read-only browser sampling. Event Timing is thresholded; not a complete INP. LoAF captures only long frames; source totals are partial and may overlap.',
      summary: summarize(session),
      recording: session,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'chatgpt-phase5-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
    anchor.style.display = 'none';
    document.documentElement.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    console.info('[Render Lite Phase 5] Export complete. Summary:', payload.summary);
  }

  GM_registerMenuCommand('Phase 5：开始采样', start);
  GM_registerMenuCommand('Phase 5：停止采样', stop);
  GM_registerMenuCommand('Phase 5：导出 JSON 报告', exportJson);
})();
