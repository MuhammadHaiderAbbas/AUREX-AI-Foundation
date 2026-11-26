/**
 * Browser tree ensembles for the demo Model Lab, mirroring the backend's settings
 * (backend/app/ml/models.py) closely enough to compare like for like:
 *   - random forest: bootstrap rows, sqrt(features) per split, depth ≤ 5, ≥ 40 rows per leaf (Gini)
 *   - gradient boosting (LightGBM-style): logistic loss, leaf-wise up to 15 leaves, ≥ 50 rows per
 *     leaf, learning rate 0.03, 80% row and feature subsampling, L2 = 1
 * Features are pre-binned into ≤ 32 quantile bins (histogram splits, as LightGBM does), so a
 * full walk-forward stays well under a second. Seeded, so results are reproducible.
 */

type Node = { f: number; t: number; l: Node; r: Node } | { v: number };
export interface Forest { kind: "random_forest"; trees: Node[]; importance: number[] }
export interface Gbm { kind: "lightgbm"; base: number; lr: number; trees: Node[]; importance: number[] }

const BINS = 32;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** Quantile bin edges per feature; a row's bin b means value <= edges[b] (last bin unbounded). */
function binning(X: number[][]) {
  const d = X[0]!.length;
  const edges: number[][] = [];
  for (let j = 0; j < d; j++) {
    const col = X.map((r) => r[j]!).sort((a, b) => a - b);
    const e: number[] = [];
    for (let k = 1; k < BINS; k++) { const v = col[Math.floor((k * (col.length - 1)) / BINS)]!; if (!e.length || v > e[e.length - 1]!) e.push(v); }
    edges.push(e);
  }
  const bin = (j: number, v: number) => { const e = edges[j]!; let lo = 0, hi = e.length; while (lo < hi) { const m = (lo + hi) >> 1; if (v <= e[m]!) hi = m; else lo = m + 1; } return lo; };
  return { edges, Xb: X.map((r) => r.map((v, j) => bin(j, v))) };
}

/** Best split of `rows` on `feats` for gradient/hessian statistics (gain as in XGBoost/LightGBM). */
function bestSplit(Xb: number[][], g: number[], h: number[], rows: number[], feats: number[], minLeaf: number, lambda: number, edges: number[][]) {
  let G = 0, H = 0;
  for (const i of rows) { G += g[i]!; H += h[i]!; }
  const parent = (G * G) / (H + lambda);
  let best = { gain: 0, f: -1, t: 0 };
  for (const j of feats) {
    const gs = new Float64Array(BINS), hs = new Float64Array(BINS), ns = new Int32Array(BINS);
    for (const i of rows) { const b = Xb[i]![j]!; gs[b] = gs[b]! + g[i]!; hs[b] = hs[b]! + h[i]!; ns[b] = ns[b]! + 1; }
    let gl = 0, hl = 0, nl = 0;
    for (let b = 0; b < edges[j]!.length; b++) {
      gl += gs[b]!; hl += hs[b]!; nl += ns[b]!;
      const nr = rows.length - nl;
      if (nl < minLeaf || nr < minLeaf) continue;
      const gain = (gl * gl) / (hl + lambda) + ((G - gl) ** 2) / (H - hl + lambda) - parent;
      if (gain > best.gain) best = { gain, f: j, t: b };
    }
  }
  return { ...best, G, H };
}

function grow(Xb: number[][], g: number[], h: number[], rows: number[], o: { maxDepth: number; maxLeaves: number; minLeaf: number; lambda: number;
  feats: () => number[]; edges: number[][]; leaf: (G: number, H: number) => number; imp: number[] }): Node {
  // leaf-wise growth (best gain first), bounded by depth and leaf count
  type Open = { rows: number[]; depth: number; set: (n: Node) => void; split: ReturnType<typeof bestSplit> };
  let root: Node = { v: 0 };
  const open: Open[] = [];
  const consider = (rows: number[], depth: number, set: (n: Node) => void) => {
    const split = bestSplit(Xb, g, h, rows, o.feats(), o.minLeaf, o.lambda, o.edges);
    set({ v: o.leaf(split.G, split.H) });
    if (depth < o.maxDepth && split.f >= 0) open.push({ rows, depth, set, split });
  };
  consider(rows, 0, (n) => { root = n; });
  let leaves = 1;
  while (open.length && leaves < o.maxLeaves) {
    open.sort((a, b) => b.split.gain - a.split.gain);
    const { rows: rs, depth, set, split } = open.shift()!;
    o.imp[split.f] = o.imp[split.f]! + split.gain;
    const L = rs.filter((i) => Xb[i]![split.f]! <= split.t), R = rs.filter((i) => Xb[i]![split.f]! > split.t);
    const node = { f: split.f, t: o.edges[split.f]![split.t]!, l: { v: 0 } as Node, r: { v: 0 } as Node };
    set(node);
    leaves++;
    consider(L, depth + 1, (n) => { node.l = n; });
    consider(R, depth + 1, (n) => { node.r = n; });
  }
  return root;
}

const walk = (n: Node, r: number[]): number => ("v" in n ? n.v : walk(r[n.f]! <= n.t ? n.l : n.r, r));
const sigmoid = (z: number) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));

export function fitForest(X: number[][], y: number[], nTrees = 60, seed = 7): Forest {
  const { edges, Xb } = binning(X), d = X[0]!.length, n = X.length, rand = rng(seed);
  const mtry = Math.max(1, Math.round(Math.sqrt(d))), imp = new Array(d).fill(0);
  const h = new Array(n).fill(1);
  const trees: Node[] = [];
  for (let k = 0; k < nTrees; k++) {
    const counts = new Array(n).fill(0);
    for (let i = 0; i < n; i++) counts[Math.floor(rand() * n)]++;
    const rows: number[] = []; counts.forEach((c, i) => { for (let m = 0; m < c; m++) rows.push(i); });
    // Gini reduction is proportional to the squared-error gain on y with unit hessians.
    const g = y.map((v) => -v);
    trees.push(grow(Xb, g, h, rows, { maxDepth: 5, maxLeaves: 32, minLeaf: 40, lambda: 0, edges, imp,
      feats: () => { const all = [...Array(d).keys()]; for (let i = d - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [all[i], all[j]] = [all[j]!, all[i]!]; } return all.slice(0, mtry); },
      leaf: (G, H) => (H ? -G / H : 0.5) }));
  }
  return { kind: "random_forest", trees, importance: imp };
}

export function fitGbm(X: number[][], y: number[], rounds = 120, seed = 7): Gbm {
  const { edges, Xb } = binning(X), d = X[0]!.length, n = X.length, rand = rng(seed);
  const mean = Math.min(0.99, Math.max(0.01, y.reduce((a, b) => a + b, 0) / n));
  const base = Math.log(mean / (1 - mean)), lr = 0.03, imp = new Array(d).fill(0);
  const F = new Array(n).fill(base), trees: Node[] = [];
  for (let k = 0; k < rounds; k++) {
    const p = F.map(sigmoid), g = p.map((v, i) => v - y[i]!), h = p.map((v) => Math.max(1e-6, v * (1 - v)));
    const rows = [...Array(n).keys()].filter(() => rand() < 0.8);
    const fs = [...Array(d).keys()].filter(() => rand() < 0.8);
    const tree = grow(Xb, g, h, rows, { maxDepth: 8, maxLeaves: 15, minLeaf: 50, lambda: 1, edges, imp, feats: () => fs, leaf: (G, H) => -G / (H + 1) });
    trees.push(tree);
    for (let i = 0; i < n; i++) F[i] += lr * walk(tree, X[i]!);
  }
  return { kind: "lightgbm", base, lr, trees, importance: imp };
}

export function predictTrees(m: Forest | Gbm, r: number[]) {
  if (m.kind === "random_forest") return Math.min(1, Math.max(0, m.trees.reduce((s, t) => s + walk(t, r), 0) / m.trees.length));
  return sigmoid(m.trees.reduce((s, t) => s + m.lr * walk(t, r), m.base));
}
