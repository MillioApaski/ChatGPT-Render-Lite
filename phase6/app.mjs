import { VirtualTimeline, MAX_FULL_ROWS } from './virtual-list.mjs';
import { syntheticConversation, syntheticMessage } from './fixtures.mjs';

const $ = (id) => document.getElementById(id);
const ui = {
  demoSize: $('demo-size'), loadDemo: $('load-demo'), file: $('file-import'),
  picker: $('conversation-picker'), search: $('conversation-search'),
  mode: $('render-mode'), prepend: $('prepend'), jump: $('jump-middle'),
  benchmark: $('benchmark'), scroll: $('scroller'),
  title: $('conversation-title'), modePill: $('mode-pill'), range: $('view-range'),
  total: $('total-count'), mounted: $('mounted-count'),
  renderCost: $('render-cost'), domCount: $('dom-count'), heap: $('heap-count'),
  output: $('benchmark-output'), status: $('status'),
};

let busy = false;
let imported = false;
let prependSeed = 0;
let catalog = [];
let latestStats = null;
let lastStatsAt = -Infinity;
const results = {};
const observed = { longtask: [], loaf: [] };

function setStatus(message) { ui.status.textContent = String(message); }
function formatNumber(n) { return Number(n).toLocaleString('zh-CN'); }
function round(n) { return Number(n.toFixed(1)); }
function percentile(arr, quantile) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1))];
}
const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve(performance.now())));

function updateStatistics(info) {
  latestStats = info;
  const now = performance.now();
  if (now - lastStatsAt < 150) return;
  lastStatsAt = now;
  ui.total.textContent = formatNumber(info.total);
  ui.mounted.textContent = formatNumber(info.mounted);
  ui.renderCost.textContent = round(info.renderMs) + 'ms';
  ui.range.textContent = info.total
    ? '当前挂载：#' + (info.start + 1) + '–#' + info.end + ' / ' + formatNumber(info.total)
    : '没有可显示的消息';
  ui.modePill.textContent = info.mode === 'virtual' ? 'VIRTUAL' : 'FULL DOM';
}

const timeline = new VirtualTimeline(ui.scroll, {
  estimate: 220, overscanPx: 900, onStats: updateStatistics,
});

function updateMemory() {
  ui.domCount.textContent = formatNumber(document.getElementsByTagName('*').length);
  const bytes = performance.memory?.usedJSHeapSize;
  ui.heap.textContent = Number.isFinite(bytes)
    ? round(bytes / 1024 / 1024) + ' MB' : '不支持';
}

function loadMessages(messages, title) {
  imported = title.startsWith('本地导出：');
  ui.title.textContent = title;
  if (ui.mode.value === 'full' && messages.length > MAX_FULL_ROWS) {
    ui.mode.value = 'virtual';
    timeline.setMode('virtual');
    setStatus('消息超过全部 DOM 模式的 1,200 条上限，已自动恢复虚拟列表。');
  }
  timeline.setMessages(messages, { toBottom: true });
  updateMemory();
  setStatus('已加载 ' + formatNumber(messages.length) + ' 条消息，向上滚动可查看历史记录。');
}

ui.loadDemo.addEventListener('click', () => {
  try {
    const count = Number(ui.demoSize.value);
    const messages = syntheticConversation(count);
    loadMessages(messages, '合成测试对话 · ' + formatNumber(count) + ' 条');
  } catch (error) {
    setStatus(error.message);
  }
});

ui.mode.addEventListener('change', () => {
  try {
    timeline.setMode(ui.mode.value);
    updateMemory();
    setStatus('已切换到 ' + (ui.mode.value === 'full' ? '全部 DOM' : '虚拟列表') + ' 模式。');
  } catch (error) {
    ui.mode.value = timeline.mode;
    setStatus(error.message);
  }
});

ui.prepend.addEventListener('click', () => {
  try {
    const id = ++prependSeed;
    const extra = Array.from({ length: 50 }, (_, i) => syntheticMessage(i, 'history-' + id));
    timeline.prepend(extra);
    updateMemory();
    setStatus('已向顶部添加 50 条模拟历史消息。检查当前阅读位置有无跳动。');
  } catch (error) { setStatus(error.message); }
});

ui.jump.addEventListener('click', () => {
  timeline.jumpTo(Math.floor(timeline.messages.length / 2));
  setStatus('已跳转至对话中段。');
});

function observePerformance() {
  if (typeof PerformanceObserver !== 'function') return;
  const supported = new Set(PerformanceObserver.supportedEntryTypes || []);
  for (const [type, key] of [
    ['longtask', 'longtask'], ['long-animation-frame', 'loaf']
  ]) {
    if (!supported.has(type)) continue;
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const group = observed[key];
          group.push({ start: entry.startTime, duration: entry.duration });
          if (group.length > 5000) group.splice(0, 1000);
        }
      });
      observer.observe({ type, buffered: false });
    } catch { /* Optional browser API. */ }
  }
}
observePerformance();

function reportResults() {
  const lines = [];
  for (const mode of ['virtual', 'full']) {
    const result = results[mode];
    if (!result) continue;
    lines.push(
      (mode === 'virtual' ? '虚拟列表' : '全部 DOM') + '：',
      '  全部消息   ' + formatNumber(result.messages),
      '  当前挂载   ' + formatNumber(result.mounted),
      '  rAF P95    ' + result.frameP95 + 'ms',
      '  rAF 最大   ' + result.frameMax + 'ms',
      '  >50ms间隔  ' + result.slowFrameIntervals,
      '  Long Tasks ' + result.longTasks,
      '  Long Frames ' + result.longFrames,
      '  全程耗时   ' + result.elapsedMs + 'ms',
      ''
    );
  }
  lines.push('提示：两次测试须使用相同消息数据与浏览器环境；程序滚动无法复现原站全部交互负担。');
  ui.output.textContent = lines.join('\n');
}

ui.benchmark.addEventListener('click', async () => {
  if (busy || !timeline.messages.length) return;
  busy = true;
  ui.benchmark.disabled = true;
  const mode = timeline.mode;
  setStatus('正在逐帧从底部向上滚动，避免切换浏览器标签页。');
  try {
    timeline.jumpTo(timeline.messages.length - 1);
    await frame();
    await frame();

    const maxScroll = Math.max(0, ui.scroll.scrollHeight - ui.scroll.clientHeight);
    const start = performance.now();
    const steps = 90;
    const gaps = [];
    let previous = await frame();

    for (let i = 0; i < steps; i++) {
      ui.scroll.scrollTop = maxScroll * (1 - i / (steps - 1));
      const now = await frame();
      gaps.push(now - previous);
      previous = now;
    }
    await frame();
    await frame();

    const end = performance.now();
    // Observer entries may include long tasks that overlap the window; use
    // startTime filtering and keep the original entry type distinctions.
    const range = (key) => observed[key].filter((x) =>
      x.start >= start && x.start <= end
    );
    results[mode] = {
      messages: timeline.messages.length,
      mounted: latestStats?.mounted ?? 0,
      frameP95: round(percentile(gaps, .95) || 0),
      frameMax: round(Math.max(...gaps)),
      slowFrameIntervals: gaps.filter((x) => x > 50).length,
      longTasks: range('longtask').length,
      longFrames: range('loaf').length,
      elapsedMs: round(end - start),
    };
    reportResults();
    updateMemory();
    setStatus('基准完成。切换渲染模式并运行同一组数据，即可比较。');
  } catch (error) {
    setStatus('基准失败：' + error.message);
  } finally {
    busy = false;
    ui.benchmark.disabled = false;
  }
});

let worker;
try {
  worker = new Worker(new URL('./import-worker.mjs', import.meta.url), { type: 'module' });
  worker.addEventListener('message', (event) => {
    const { type, error, messages, title } = event.data || {};
    if (type === 'error') {
      setStatus('导入失败：' + error);
    } else if (type === 'catalog') {
      catalog = event.data.catalog;
      ui.search.disabled = false;
      refreshPicker();
      setStatus('已在本地解析 ' + formatNumber(catalog.length) + ' 条会话，可按标题筛选。');
    } else if (type === 'messages') {
      loadMessages(messages, '本地导出：' + title);
    }
  });
  worker.addEventListener('error', () => setStatus('导入 Worker 启动失败。请通过 http://localhost 打开原型，不要直接打开 file://。'));
} catch {
  setStatus('当前环境不支持模块 Worker。仍可使用合成数据验证。');
  ui.file.disabled = true;
}

function refreshPicker() {
  const needle = ui.search.value.trim().toLocaleLowerCase();
  const options = catalog.filter((c) =>
    !needle || c.title.toLocaleLowerCase().includes(needle)
  ).slice(0, 200);
  const fragment = document.createDocumentFragment();
  for (const entry of options) {
    const option = document.createElement('option');
    option.value = String(entry.index);
    option.textContent = entry.title + '（节点 ' + formatNumber(entry.graphSize) + '）';
    fragment.append(option);
  }
  ui.picker.replaceChildren(fragment);
  ui.picker.disabled = options.length === 0;
  if (options.length) {
    ui.picker.selectedIndex = 0;
    worker?.postMessage({ type: 'conversation', index: Number(options[0].index) });
  } else {
    setStatus('没有匹配的对话标题。');
  }
}

ui.file.addEventListener('change', () => {
  const file = ui.file.files?.[0];
  if (!file || !worker) return;
  ui.search.value = '';
  ui.search.disabled = true;
  ui.picker.disabled = true;
  setStatus('正在本地 Worker 中解析 ' + formatNumber(file.size) + ' 字节 JSON…');
  worker.postMessage({ type: 'open', file });
});
ui.search.addEventListener('input', refreshPicker);
ui.picker.addEventListener('change', () => {
  const index = Number(ui.picker.value);
  if (Number.isInteger(index)) worker?.postMessage({ type: 'conversation', index });
});

setInterval(updateMemory, 5000);
ui.loadDemo.click();
