// Connected-component labeling via two-pass union-find.

class UnionFind {
  parent: Int32Array;

  constructor(n: number) {
    this.parent = new Int32Array(n);
    for (let i = 0; i < n; i++) this.parent[i] = i;
  }

  find(x: number): number {
    while (this.parent[x] !== x) {
      this.parent[x] = this.parent[this.parent[x]];
      x = this.parent[x];
    }
    return x;
  }

  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[Math.max(ra, rb)] = Math.min(ra, rb);
  }
}

export interface CclResult {
  labels: Int32Array; // 0 = background (mask value 0), 1..count = components
  count: number;
  areas: Uint32Array; // areas[label] for label in 1..count
}

/**
 * Labels connected components of pixels where mask[i] !== 0.
 * connectivity: 4 (spec default for piece labeling) or 8 (used for despeckle,
 * so diagonal ink specks merge into one component).
 */
export function labelComponents(mask: Uint8Array, width: number, height: number, connectivity: 4 | 8 = 4): CclResult {
  const n = width * height;
  const provisional = new Int32Array(n); // 0 = unlabeled/background
  const uf = new UnionFind(n + 1); // +1 slot unused, keeps ids 1-based friendly
  let next = 1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (mask[i] === 0) continue;
      const neighbors: number[] = [];
      if (x > 0 && mask[i - 1] !== 0) neighbors.push(provisional[i - 1]);
      if (y > 0 && mask[i - width] !== 0) neighbors.push(provisional[i - width]);
      if (connectivity === 8) {
        if (x > 0 && y > 0 && mask[i - width - 1] !== 0) neighbors.push(provisional[i - width - 1]);
        if (x < width - 1 && y > 0 && mask[i - width + 1] !== 0) neighbors.push(provisional[i - width + 1]);
      }
      if (neighbors.length === 0) {
        provisional[i] = next++;
      } else {
        let m = neighbors[0];
        for (const nb of neighbors) if (nb < m) m = nb;
        provisional[i] = m;
        for (const nb of neighbors) if (nb !== m) uf.union(m, nb);
      }
    }
  }

  // Second pass: resolve to canonical roots, then compact to dense 1..count.
  const rootToLabel = new Map<number, number>();
  const labels = new Int32Array(n);
  let count = 0;
  for (let i = 0; i < n; i++) {
    if (provisional[i] === 0) continue;
    const root = uf.find(provisional[i]);
    let label = rootToLabel.get(root);
    if (label === undefined) {
      label = ++count;
      rootToLabel.set(root, label);
    }
    labels[i] = label;
  }

  const areas = new Uint32Array(count + 1);
  for (let i = 0; i < n; i++) {
    if (labels[i] > 0) areas[labels[i]]++;
  }

  return { labels, count, areas };
}
