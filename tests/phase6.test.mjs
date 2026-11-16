import test from 'node:test';
import assert from 'node:assert/strict';
import { HeightIndex, visibleRange } from '../phase6/height-index.mjs';
import { catalogConversations, extractConversation, extractMessageText, getExportConversations } from '../phase6/export-parser.mjs';
import { syntheticConversation } from '../phase6/fixtures.mjs';

test('Fenwick height index uses exact prefixes and O(log n) offset lookup', () => {
  const heights = new HeightIndex(5, 100);
  assert.equal(heights.total, 500);
  heights.update(1, 150);
  heights.update(3, 60);
  assert.deepEqual(Array.from({ length: 6 }, (_, i) => heights.prefix(i)), [0, 100, 250, 350, 410, 510]);
  assert.deepEqual([0, 99, 100, 249, 250, 349, 350, 409, 410, 999].map((x) => heights.indexAt(x)),
    [0, 0, 1, 1, 2, 2, 3, 3, 4, 4]);
  assert.equal(heights.update(2, 100), 0);
});

test('random variable height updates match a linear oracle', () => {
  const n = 2000;
  const heights = new HeightIndex(n, 80);
  const oracle = new Array(n).fill(80);
  for (let i = 0; i < n; i += 7) {
    const height = 20 + (i * 53) % 420;
    heights.update(i, height);
    oracle[i] = height;
  }
  const cumulative = [0];
  for (const h of oracle) cumulative.push(cumulative.at(-1) + h);
  for (let i = 0; i < n; i += 11) assert.equal(heights.prefix(i), cumulative[i]);
  assert.equal(heights.total, cumulative[n]);
  for (let j = 0; j < 120; j++) {
    const offset = Math.floor(j * cumulative[n] / 119);
    const expected = Math.max(0, cumulative.findIndex((x) => x > offset) - 1);
    assert.equal(heights.indexAt(offset), Math.min(n - 1, expected));
  }
});

test('virtual window is bounded, and prepend preserves previously measured heights', () => {
  const heights = new HeightIndex(10000, 200);
  const window = visibleRange(heights, 750000, 800, 900);
  assert.ok(window.end - window.start <= 15);
  assert.equal(window.top + (heights.prefix(window.end) - heights.prefix(window.start)) + window.bottom, heights.total);
  heights.update(5, 321);
  heights.prepend(50);
  assert.equal(heights.length, 10050);
  assert.equal(heights.heights[55], 321);
  assert.equal(heights.prefix(50), 10000);
});

test('empty and invalid height data are handled safely', () => {
  const empty = new HeightIndex();
  assert.deepEqual(visibleRange(empty, 5, 100), { start: 0, end: 0, top: 0, bottom: 0 });
  assert.equal(empty.indexAt(0), 0);
  assert.throws(() => new HeightIndex(-1));
  assert.throws(() => empty.update(0, 100));
  const h = new HeightIndex(1, 100);
  assert.equal(h.update(0, Number.NaN), 0);
  assert.equal(h.total, 100);
});

function sampleExport() {
  return [{
    id: 'c-one',
    title: '很长的旧对话',
    update_time: 13,
    current_node: 'final',
    mapping: {
      root: { parent: null, message: null },
      u: { parent: 'root', message: { author: { role: 'user' }, content: { parts: ['first'] } } },
      unused: { parent: 'u', message: { author: { role: 'assistant' }, content: { parts: ['wrong branch'] } } },
      a: { parent: 'u', message: { author: { role: 'assistant' }, content: { parts: ['reply', { content_type: 'image_asset_pointer' }] } } },
      tool: { parent: 'a', message: { author: { role: 'tool' }, content: { parts: ['hidden tool'] } } },
      final: { parent: 'tool', message: { author: { role: 'assistant' }, content: { parts: ['<script>do not run</script>'] } } },
    }
  }, {
    id: 'c-two', title: '新对话', update_time: 20, mapping: {}
  }];
}

test('chatgpt export catalog sorts by updated time and current-node branch', () => {
  const exports = sampleExport();
  assert.equal(getExportConversations(exports), exports);
  const catalog = catalogConversations(exports);
  assert.deepEqual(catalog.map((x) => x.id), ['c-two', 'c-one']);
  const selected = extractConversation(exports[0]);
  assert.deepEqual(selected.map((m) => m.text), [
    'first', 'reply\n[图片附件，原型暂不渲染]', '<script>do not run</script>'
  ]);
  assert.equal(selected.length, 3);
  assert.equal(selected[2].role, 'assistant');
});

test('export parser gracefully ignores unrelated messages and rejects non-exports', () => {
  assert.throws(() => getExportConversations({ unknown: true }));
  assert.equal(extractMessageText({ content: { parts: [{ text: 'nested' }] } }), 'nested');
  const result = extractConversation({
    current_node: 'two',
    mapping: {
      one: { parent: null, message: { author: { role: 'user' }, content: { parts: ['visible'] } } },
      two: { parent: 'one', message: { author: { role: 'assistant' }, recipient: 'python', content: { parts: ['not visible'] } } },
    }
  });
  assert.deepEqual(result.map((m) => m.text), ['visible']);
});

test('synthetic fixtures are deterministic, with varying heights and text length', () => {
  const a = syntheticConversation(100);
  const b = syntheticConversation(100);
  assert.deepEqual(a, b);
  assert.notEqual(a[0].text.length, a[1].text.length);
  assert.ok(a[0].text.includes('<script>'));
  assert.throws(() => syntheticConversation(20001));
});

class FakeNode {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.dataset = {};
    this.style = {};
    this.parentNode = null;
    this.textContent = '';
    this.clientHeight = 800;
    this.scrollTop = 0;
    this.listeners = new Map();
  }
  get firstChild() { return this.children[0] || null; }
  get nextSibling() {
    if (!this.parentNode) return null;
    return this.parentNode.children[this.parentNode.children.indexOf(this) + 1] || null;
  }
  append(...nodes) {
    for (const node of nodes) {
      if (node.tagName === '#fragment') {
        for (const child of [...node.children]) this.append(child);
      } else {
        node.remove();
        this.children.push(node);
        node.parentNode = this;
      }
    }
  }
  replaceChildren(...nodes) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this.append(...nodes);
  }
  insertBefore(node, sibling) {
    if (node === sibling) return;
    node.remove();
    const index = sibling ? this.children.indexOf(sibling) : -1;
    if (index < 0) this.children.push(node);
    else this.children.splice(index, 0, node);
    node.parentNode = this;
  }
  remove() {
    if (this.parentNode) {
      const arr = this.parentNode.children;
      arr.splice(arr.indexOf(this), 1);
      this.parentNode = null;
    }
  }
  addEventListener(type, fn) { this.listeners.set(type, fn); }
  removeEventListener(type) { this.listeners.delete(type); }
  getBoundingClientRect() { return { height: 220 }; }
  scrollIntoView() {}
}

test('rendering 10,000 messages mounts only the current virtual window', async () => {
  const old = { document: globalThis.document, ResizeObserver: globalThis.ResizeObserver };
  globalThis.document = {
    createElement: (tag) => new FakeNode(tag),
    createDocumentFragment: () => new FakeNode('#fragment'),
  };
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
    unobserve() {}
  };
  try {
    const { VirtualTimeline } = await import('../phase6/virtual-list.mjs');
    const scroller = new FakeNode('div');
    const renderer = new VirtualTimeline(scroller);
    const messages = syntheticConversation(10000);
    renderer.setMessages(messages);
    assert.equal(renderer.messages.length, 10000);
    assert.ok(renderer.nodes.size < 30, 'virtual mode should not mount all 10000 rows');
    renderer.jumpTo(4000);
    renderer.render();
    assert.ok(renderer.nodes.size < 30);
    assert.equal(renderer.rows.children.length, renderer.nodes.size);
    const preserved = scroller.scrollTop;
    renderer.prepend(syntheticConversation(50, 'old'));
    assert.equal(renderer.messages.length, 10050);
    assert.ok(scroller.scrollTop > preserved);
    assert.ok(renderer.nodes.size < 30);
    assert.throws(() => renderer.setMode('full'));
    renderer.destroy();
  } finally {
    globalThis.document = old.document;
    globalThis.ResizeObserver = old.ResizeObserver;
  }
});
