import { HeightIndex, visibleRange } from './height-index.mjs';

const MAX_FULL_ROWS = 1200;

function element(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = String(text);
  return node;
}

// Deliberately safe subset: no innerHTML, remote images, links or untrusted HTML.
// Its different fidelity from ChatGPT's rich renderer is documented in README.
export function renderSafeText(text, destination) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  let code = false;
  let buffer = [];
  const flush = () => {
    if (!buffer.length) return;
    destination.append(element(code ? 'pre' : 'p', code ? 'code-block' : 'paragraph', buffer.join('\n')));
    buffer = [];
  };
  for (const line of lines) {
    if (/^\s*`{3}/.test(line)) {
      flush();
      code = !code;
      continue;
    }
    if (!code && /^\s*#{1,3}\s+/.test(line)) {
      flush();
      destination.append(element('h3', 'message-heading', line.replace(/^\s*#{1,3}\s+/, '')));
    } else if (!code && /^\s*[-*]\s+/.test(line)) {
      flush();
      destination.append(element('p', 'bullet', '• ' + line.replace(/^\s*[-*]\s+/, '')));
    } else if (!code && line.trim() === '') {
      flush();
    } else {
      buffer.push(line);
    }
  }
  flush();
}

function createTurn(message, index) {
  const row = element('article', 'turn turn--' + (message.role === 'user' ? 'user' : 'assistant'));
  row.dataset.index = String(index);
  const header = element('header', 'turn-header');
  header.append(element('strong', '', message.role === 'user' ? '你' : message.role === 'assistant' ? 'ChatGPT' : message.role));
  header.append(element('span', 'turn-number', '#' + (index + 1)));
  const body = element('div', 'turn-body');
  renderSafeText(message.text, body);
  row.append(header, body);
  return row;
}

export class VirtualTimeline {
  constructor(scroller, { estimate = 220, overscanPx = 900, onStats = () => {} } = {}) {
    if (!scroller) throw new TypeError('Scroller required');
    this.scroller = scroller;
    this.estimate = estimate;
    this.overscanPx = overscanPx;
    this.onStats = onStats;
    this.messages = [];
    this.index = new HeightIndex(0, estimate);
    this.mode = 'virtual';
    this.nodes = new Map();
    this.raf = 0;
    this.destroyed = false;
    this.topSpacer = element('div', 'timeline-spacer');
    this.rows = element('div', 'timeline-rows');
    this.bottomSpacer = element('div', 'timeline-spacer');
    const surface = element('div', 'timeline-surface');
    surface.append(this.topSpacer, this.rows, this.bottomSpacer);
    scroller.replaceChildren(surface);
    this.onScroll = () => this.scheduleRender();
    scroller.addEventListener('scroll', this.onScroll, { passive: true });
    this.resizeObserver = typeof ResizeObserver === 'function'
      ? new ResizeObserver((entries) => this.onResize(entries)) : null;
  }

  setMessages(messages, { toBottom = true } = {}) {
    if (!Array.isArray(messages)) throw new TypeError('Messages must be an array');
    this.messages = messages;
    this.index.reset(messages.length);
    this.resetNodes();
    this.scroller.scrollTop = toBottom ? this.index.total : 0;
    this.render();
  }

  setMode(mode) {
    if (mode !== 'virtual' && mode !== 'full') throw new RangeError('Unknown render mode');
    if (mode === 'full' && this.messages.length > MAX_FULL_ROWS) {
      throw new RangeError('Full DOM baseline is limited to 1,200 messages to avoid freezing the browser.');
    }
    if (mode === this.mode) return;
    this.mode = mode;
    this.resetNodes();
    this.scroller.scrollTop = 0;
    this.render();
  }

  prepend(messages) {
    if (!Array.isArray(messages) || !messages.length) return;
    if (this.mode === 'full' && this.messages.length + messages.length > MAX_FULL_ROWS) {
      throw new RangeError('Full DOM baseline limit exceeded.');
    }
    const delta = messages.length * this.estimate;
    this.messages = messages.concat(this.messages);
    this.index.prepend(messages.length);
    // Preserve the old top-visible content's approximate document offset.
    this.scroller.scrollTop += delta;
    this.resetNodes();
    this.render();
  }

  jumpTo(index) {
    const i = Math.max(0, Math.min(this.messages.length - 1, Math.trunc(index)));
    if (!this.messages.length) return;
    // In full mode, the rendered DOM may have different real heights.
    if (this.mode === 'full') this.rows.children[i]?.scrollIntoView({ block: 'start' });
    else this.scroller.scrollTop = this.index.prefix(i);
    this.scheduleRender();
  }

  scheduleRender() {
    if (this.raf || this.destroyed) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.render();
    });
  }

  resetNodes() {
    if (this.resizeObserver) this.resizeObserver.disconnect();
    this.nodes.clear();
    this.rows.replaceChildren();
  }

  onResize(entries) {
    if (this.mode !== 'virtual' || this.destroyed) return;
    const firstVisible = this.index.indexAt(this.scroller.scrollTop);
    let correction = 0;
    let modified = false;
    for (const entry of entries) {
      const i = Number(entry.target.dataset.index);
      if (!Number.isInteger(i) || i < 0 || i >= this.index.length) continue;
      const box = entry.borderBoxSize;
      const height = box?.[0]?.blockSize ?? entry.target.getBoundingClientRect().height;
      const delta = this.index.update(i, height);
      if (!delta) continue;
      modified = true;
      if (i < firstVisible) correction += delta;
    }
    if (correction) this.scroller.scrollTop += correction;
    if (modified) this.scheduleRender();
  }

  render() {
    if (this.destroyed) return;
    const started = performance.now();
    if (this.mode === 'full') {
      if (!this.nodes.size && this.messages.length) {
        const frag = document.createDocumentFragment();
        this.messages.forEach((message, i) => {
          const node = createTurn(message, i);
          frag.append(node);
          this.nodes.set(message.id, node);
        });
        this.rows.append(frag);
      }
      this.topSpacer.style.height = '0px';
      this.bottomSpacer.style.height = '0px';
      this.onStats({
        mode: this.mode, total: this.messages.length, mounted: this.nodes.size,
        start: 0, end: this.messages.length,
        renderMs: performance.now() - started,
      });
      return;
    }

    const { start, end, top, bottom } = visibleRange(
      this.index, this.scroller.scrollTop, this.scroller.clientHeight, this.overscanPx
    );
    const next = new Map();
    let sibling = this.rows.firstChild;
    for (let i = start; i < end; i++) {
      const message = this.messages[i];
      let row = this.nodes.get(message.id);
      const fresh = !row;
      if (!row) row = createTurn(message, i);
      row.dataset.index = String(i);
      next.set(message.id, row);
      if (row === sibling) {
        sibling = sibling.nextSibling;
      } else {
        this.rows.insertBefore(row, sibling);
      }
      if (fresh) this.resizeObserver?.observe(row);
    }
    // Remove rows no longer within the current window.
    for (const [key, node] of this.nodes) {
      if (!next.has(key)) {
        this.resizeObserver?.unobserve(node);
        node.remove();
      }
    }
    this.nodes = next;
    const topPx = top + 'px';
    const bottomPx = bottom + 'px';
    if (this.topSpacer.style.height !== topPx) this.topSpacer.style.height = topPx;
    if (this.bottomSpacer.style.height !== bottomPx) this.bottomSpacer.style.height = bottomPx;
    this.onStats({
      mode: this.mode, total: this.messages.length, mounted: this.nodes.size,
      start, end, renderMs: performance.now() - started,
    });
  }

  destroy() {
    this.destroyed = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.scroller.removeEventListener('scroll', this.onScroll);
    this.resizeObserver?.disconnect();
    this.resetNodes();
  }
}
export { MAX_FULL_ROWS };
