// A variable-height Fenwick tree: O(log n) updates, prefix lookups and offset→row.
export class HeightIndex {
  constructor(count = 0, estimate = 180) {
    if (!Number.isFinite(estimate) || estimate <= 0) throw new RangeError('Invalid estimate');
    this.estimate = estimate;
    this.reset(count);
  }

  reset(count) {
    if (!Number.isSafeInteger(count) || count < 0) throw new RangeError('Invalid count');
    this.heights = new Array(count).fill(this.estimate);
    this.rebuild();
  }

  rebuild() {
    const n = this.heights.length;
    this.tree = new Float64Array(n + 1);
    for (let i = 1; i <= n; i++) {
      this.tree[i] += this.heights[i - 1];
      const parent = i + (i & -i);
      if (parent <= n) this.tree[parent] += this.tree[i];
    }
  }

  get length() { return this.heights.length; }
  get total() { return this.prefix(this.length); }

  prefix(end) {
    if (!Number.isSafeInteger(end) || end < 0 || end > this.length) {
      throw new RangeError('Prefix index out of range');
    }
    let sum = 0;
    for (let i = end; i > 0; i -= i & -i) sum += this.tree[i];
    return sum;
  }

  update(index, height) {
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.length) {
      throw new RangeError('Height index out of range');
    }
    if (!Number.isFinite(height) || height <= 0) return 0;
    const next = Math.max(1, Math.ceil(height));
    const delta = next - this.heights[index];
    if (!delta) return 0;
    this.heights[index] = next;
    for (let i = index + 1; i <= this.length; i += i & -i) this.tree[i] += delta;
    return delta;
  }

  indexAt(offset) {
    if (!this.length) return 0;
    const target = Math.max(0, Math.min(this.total - 0.001, Number(offset) || 0));
    let index = 0;
    let sum = 0;
    let bit = 1;
    while ((bit << 1) <= this.length) bit <<= 1;
    for (; bit > 0; bit >>= 1) {
      const next = index + bit;
      if (next <= this.length && sum + this.tree[next] <= target) {
        index = next;
        sum += this.tree[next];
      }
    }
    return Math.min(index, this.length - 1);
  }

  prepend(count) {
    if (!Number.isSafeInteger(count) || count < 0) throw new RangeError('Invalid prepend count');
    if (!count) return;
    this.heights = new Array(count).fill(this.estimate).concat(this.heights);
    this.rebuild();
  }
}

export function visibleRange(heights, scrollTop, viewportHeight, overscanPx = 800) {
  if (!heights.length) return { start: 0, end: 0, top: 0, bottom: 0 };
  const top = Math.max(0, scrollTop);
  const over = Math.max(0, overscanPx);
  const start = heights.indexAt(Math.max(0, top - over));
  const edge = Math.max(0, top + Math.max(1, viewportHeight) + over);
  const end = Math.min(heights.length, heights.indexAt(edge) + 1);
  return {
    start, end,
    top: heights.prefix(start),
    bottom: heights.total - heights.prefix(end),
  };
}
