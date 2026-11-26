/**
 * Browser port of backend/app/ml for the static demo: leak-free features, an L2 logistic
 * regression trained by gradient descent, purged walk-forward validation after costs,
 * validation gates and PSI drift. Random forest and LightGBM-style boosting are in ./trees.
 */
import { ema, rsi, sma } from "./market";

import { fitForest, fitGbm, predictTrees, type Forest, type Gbm } from "./trees";

export const FEATURES = ["ret_1", "ret_4", "ret_24", "vol_24", "vol_72", "vol_ratio", "rsi_14", "macd_atr", "trend_atr", "bb_pctb", "er_24", "dist_high_72", "hour_sin", "hour_cos"];
const WARMUP = 80;
export interface Bar { t: string; h: number; l: number; c: number }
export interface Dataset { X: number[][]; y: number[]; fwd: number[]; times: string[]; horizon: number }

const std = (a: number[]) => { if (a.length < 2) return NaN; const m = a.reduce((x, y) => x + y, 0) / a.length; return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const rollStd = (x: number[], n: number) => x.map((_, t) => (t >= n - 1 ? std(x.slice(t - n + 1, t + 1)) : NaN));

export function featureMatrix(b: Bar[]): number[][] {
  const n = b.length, c = b.map((x) => x.c), h = b.map((x) => x.h), lo = b.map((x) => x.l);
  const logc = c.map(Math.log), r1 = logc.map((v, i) => (i ? v - logc[i - 1]! : NaN));
  const lag = (k: number) => logc.map((v, i) => (i >= k ? v - logc[i - k]! : NaN));
  const v24 = rollStd(r1, 24), v72 = rollStd(r1, 72);
  const rs = rsi(c, 14), s20 = sma(c, 20), s50 = sma(c, 50);
  const e12 = ema(c, 12), e26 = ema(c, 26);
  const line = e12.map((v, i) => (v != null && e26[i] != null ? v - e26[i]! : null));
  const st = line.findIndex((v) => v != null);
  const sig = st < 0 ? [] : [...Array(st).fill(null), ...ema(line.slice(st) as number[], 9)];
  const tr = c.map((_, i) => { const p = i ? c[i - 1]! : c[0]!; return Math.max(h[i]! - lo[i]!, Math.abs(h[i]! - p), Math.abs(lo[i]! - p)); });
  const atr = c.map((_, t) => (t >= 14 ? tr.slice(t - 13, t + 1).reduce((x, y) => x + y, 0) / 14 : NaN));
  const sd20 = rollStd(c, 20);
  const absd = c.map((v, i) => (i ? Math.abs(v - c[i - 1]!) : 0));
  const rows: number[][] = [];
  for (let t = 0; t < n; t++) {
    const path = t >= 24 ? absd.slice(t - 23, t + 1).reduce((x, y) => x + y, 0) : NaN;
    const hi72 = t >= 71 ? Math.max(...h.slice(t - 71, t + 1)) : NaN;
    const date = new Date(b[t]!.t), hr = date.getUTCHours() + date.getUTCMinutes() / 60;
    const hist = line[t] != null && sig[t] != null ? line[t]! - sig[t]! : NaN;
    const row = [r1[t]!, lag(4)[t]!, lag(24)[t]!, v24[t]!, v72[t]!, v24[t]! / v72[t]!, rs[t] == null ? NaN : (rs[t]! - 50) / 50,
      hist / atr[t]!, s20[t] == null || s50[t] == null ? NaN : (s20[t]! - s50[t]!) / atr[t]!,
      s20[t] == null ? NaN : (c[t]! - (s20[t]! - 2 * sd20[t]!)) / (4 * sd20[t]!), t >= 24 ? (path ? Math.abs(c[t]! - c[t - 24]!) / path : 0) : NaN,
      c[t]! / hi72 - 1, Math.sin((2 * Math.PI * hr) / 24), Math.cos((2 * Math.PI * hr) / 24)];
    rows.push(row.map((v) => (Number.isFinite(v) ? v : NaN)));
  }
  return rows;
}

export function buildDataset(b: Bar[], horizon: number): Dataset {
  const X = featureMatrix(b), c = b.map((x) => x.c);
  const out: Dataset = { X: [], y: [], fwd: [], times: [], horizon };
  for (let t = WARMUP; t < b.length - horizon; t++) {
    if (!X[t]!.every(Number.isFinite)) continue;
    const f = c[t + horizon]! / c[t]! - 1;
    out.X.push(X[t]!); out.y.push(f > 0 ? 1 : 0); out.fwd.push(f); out.times.push(b[t]!.t);
  }
  return out;
}

// ---- logistic regression (standardised, L2, batch gradient descent) ----------------
export interface Logit { mean: number[]; sd: number[]; w: number[]; b: number }
const sigmoid = (z: number) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
export function fitLogit(X: number[][], y: number[], C = 0.5, iters = 300, lr = 0.5): Logit {
  const d = X[0]!.length, n = X.length;
  const mean = Array.from({ length: d }, (_, j) => X.reduce((s, r) => s + r[j]!, 0) / n);
  const sd = Array.from({ length: d }, (_, j) => Math.sqrt(X.reduce((s, r) => s + (r[j]! - mean[j]!) ** 2, 0) / n) || 1);
  const Z = X.map((r) => r.map((v, j) => (v - mean[j]!) / sd[j]!));
  const w = new Array(d).fill(0); let b = 0;
  const lambda = 1 / (C * n);
  for (let it = 0; it < iters; it++) {
    const gw = new Array(d).fill(0); let gb = 0;
    for (let i = 0; i < n; i++) {
      const e = sigmoid(Z[i]!.reduce((s, v, j) => s + v * w[j]!, b)) - y[i]!;
      for (let j = 0; j < d; j++) gw[j] += e * Z[i]![j]!;
      gb += e;
    }
    for (let j = 0; j < d; j++) w[j] -= lr * (gw[j] / n + lambda * w[j]!);
    b -= lr * gb / n;
  }
  return { mean, sd, w, b };
}
export const predict = (m: Logit, r: number[]) => sigmoid(r.reduce((s, v, j) => s + ((v - m.mean[j]!) / m.sd[j]!) * m.w[j]!, m.b));

// ---- any supported algorithm --------------------------------------------------------
export type Model = (Logit & { kind?: "logistic" }) | Forest | Gbm;
export const ALGORITHMS = ["logistic", "random_forest", "lightgbm"] as const;
export function fitModel(algo: string, X: number[][], y: number[]): Model {
  if (algo === "random_forest") return fitForest(X, y);
  if (algo === "lightgbm") return fitGbm(X, y);
  return { kind: "logistic", ...fitLogit(X, y) };
}
export const predictModel = (m: Model, r: number[]) => (m.kind === "random_forest" || m.kind === "lightgbm" ? predictTrees(m, r) : predict(m, r));
/** Normalised |coefficient| (logistic) or split gain (trees), by feature. */
export function importance(m: Model): Record<string, number> {
  const raw = m.kind === "random_forest" || m.kind === "lightgbm" ? m.importance : m.w.map(Math.abs);
  const total = raw.reduce((a, b) => a + b, 0) || 1;
  return Object.fromEntries(FEATURES.map((f, j) => [f, +(raw[j]! / total).toFixed(4)] as const).sort((a, b) => b[1] - a[1]));
}

// ---- validation ------------------------------------------------------------------------
const COST: Record<string, number> = { CRYPTO: 0.0011, FX: 0.0001, STOCK: 0.0006, ETF: 0.0004 };
const BPY: Record<string, number> = { CRYPTO: 8760, FX: 6240, STOCK: 1764, ETF: 1764 };
const brier = (p: number[], y: number[]) => p.reduce((s, v, i) => s + (v - y[i]!) ** 2, 0) / p.length;
function calibration(p: number[], y: number[]) {
  const table: { bin: number; predicted: number; observed: number; count: number }[] = []; let ece = 0;
  for (let k = 0; k < 10; k++) {
    const idx = p.map((v, i) => [v, i] as const).filter(([v]) => v >= k / 10 && (k === 9 ? v <= 1 : v < (k + 1) / 10)).map(([, i]) => i);
    if (!idx.length) continue;
    const conf = idx.reduce((s, i) => s + p[i]!, 0) / idx.length, freq = idx.reduce((s, i) => s + y[i]!, 0) / idx.length;
    ece += (idx.length / p.length) * Math.abs(conf - freq);
    table.push({ bin: k, predicted: +conf.toFixed(4), observed: +freq.toFixed(4), count: idx.length });
  }
  return { ece, table };
}
function auc(p: number[], y: number[]) {
  const pos = p.filter((_, i) => y[i] === 1), neg = p.filter((_, i) => y[i] === 0);
  if (!pos.length || !neg.length) return 0.5;
  let wins = 0;
  for (const a of pos) for (const b of neg) wins += a > b ? 1 : a === b ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}
function strategy(p: number[], fwd: number[], cost: number, ppy: number) {
  let prev = 0, eq = 1, peak = 1, mdd = 0, trades = 0, held = 0, wins = 0;
  const rets: number[] = [], equity: number[] = [];
  p.forEach((v, i) => {
    const pos = v > 0.55 ? 1 : 0;
    const r = pos * fwd[i]! - cost * Math.abs(pos - prev);
    if (pos && !prev) trades++;
    if (pos) { held++; if (r > 0) wins++; }
    prev = pos; rets.push(r); eq *= 1 + r; equity.push(eq); peak = Math.max(peak, eq); mdd = Math.max(mdd, 1 - eq / peak);
  });
  const m = rets.reduce((s, x) => s + x, 0) / rets.length, s = std(rets);
  return { net_return: eq - 1, sharpe: s > 0 ? (m / s) * Math.sqrt(ppy) : 0, max_drawdown: mdd, trades, exposure: held / p.length, hit_rate: held ? wins / held : 0, periods: p.length, equity };
}
const down = (x: number[], n = 250) => (x.length <= n ? x : Array.from({ length: n }, (_, i) => x[Math.floor((i * (x.length - 1)) / (n - 1))]!)).map((v) => +v.toFixed(5));
const r5 = (v: number) => +v.toFixed(5);

export function walkForward(ds: Dataset, asset: string, source = "synthetic", algo = "logistic") {
  const n = ds.y.length, H = ds.horizon, start = Math.floor(n * 0.4), size = Math.floor((n - start) / 5);
  if (size < 5 * H || start < 200) throw new Error("Not enough data for walk-forward validation");
  const cost = COST[asset]!, ppy = BPY[asset]! / H, mom = FEATURES.indexOf("ret_24");
  const P: number[] = [], CL: number[] = [], MO: number[] = [], IDX: number[] = [], folds = [];
  for (let k = 0; k < 5; k++) {
    const s = start + k * size, e = k === 4 ? n : s + size, trainEnd = s - H;
    const model = fitModel(algo, ds.X.slice(0, trainEnd), ds.y.slice(0, trainEnd));
    const test: number[] = []; for (let i = s; i < e; i += H) test.push(i);
    const p = test.map((i) => predictModel(model, ds.X[i]!));
    const base = ds.y.slice(0, trainEnd).reduce((x, y) => x + y, 0) / trainEnd;
    const y = test.map((i) => ds.y[i]!), fwd = test.map((i) => ds.fwd[i]!);
    const ms = strategy(p, fwd, cost, ppy), bh = strategy(test.map(() => 1), fwd, cost, ppy);
    folds.push({ fold: k + 1, train_size: trainEnd, test_size: test.length, test_from: ds.times[s]!, test_to: ds.times[e - 1]!,
      brier: r5(brier(p, y)), brier_climatology: r5(brier(test.map(() => base), y)), net_return: r5(ms.net_return), buy_hold_return: r5(bh.net_return), beats_buy_hold: ms.net_return > bh.net_return });
    P.push(...p); CL.push(...test.map(() => base)); MO.push(...test.map((i) => (ds.X[i]![mom]! > 0 ? 0.6 : 0.4))); IDX.push(...test);
  }
  const y = IDX.map((i) => ds.y[i]!), fwd = IDX.map((i) => ds.fwd[i]!);
  const cal = calibration(P, y), ms = strategy(P, fwd, cost, ppy), bh = strategy(IDX.map(() => 1), fwd, cost, ppy), mo = strategy(MO, fwd, cost, ppy);
  const pub = (s: ReturnType<typeof strategy>) => { const { equity: _e, ...rest } = s; return Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, r5(v)])); };
  const oos = {
    samples: IDX.length, accuracy: +(P.filter((v, i) => (v > 0.5 ? 1 : 0) === y[i]).length / P.length).toFixed(4),
    brier: r5(brier(P, y)), brier_climatology: r5(brier(CL, y)), log_loss: r5(-P.reduce((s, v, i) => { const q = Math.min(1 - 1e-6, Math.max(1e-6, v)); return s + (y[i]! ? Math.log(q) : Math.log(1 - q)); }, 0) / P.length),
    auc: +auc(P, y).toFixed(4), ece: +cal.ece.toFixed(4), base_rate: +(y.reduce((a, b) => a + b, 0) / y.length).toFixed(4), cost_per_side: cost, threshold: 0.55,
    ...Object.fromEntries(Object.entries(pub(ms)).map(([k, v]) => [`strategy_${k}`, v])),
  } as Record<string, number>;
  const baselines = { buy_hold: pub(bh), momentum: pub(mo), climatology: { brier: r5(brier(CL, y)) } };
  const pick = Array.from({ length: Math.min(250, IDX.length) }, (_, i) => IDX[Math.floor((i * (IDX.length - 1)) / Math.max(1, Math.min(250, IDX.length) - 1))]!);
  const curves = { times: pick.map((i) => ds.times[i]!), model: down(ms.equity), buy_hold: down(bh.equity), momentum: down(mo.equity) };
  const consistency = folds.filter((f) => f.beats_buy_hold).length / folds.length;
  const g = (name: string, passed: boolean, value: string, threshold: string) => ({ name, passed, value, threshold });
  const p2 = (v: number) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(2)}%`;
  const gates = [
    g("Beats buy & hold after costs", oos.strategy_net_return! > baselines.buy_hold.net_return!, `${p2(oos.strategy_net_return!)} vs ${p2(baselines.buy_hold.net_return!)}`, "> buy & hold"),
    g("Beats momentum baseline after costs", oos.strategy_net_return! > baselines.momentum.net_return!, `${p2(oos.strategy_net_return!)} vs ${p2(baselines.momentum.net_return!)}`, "> momentum"),
    g("Probabilistic skill (Brier)", oos.brier! < oos.brier_climatology!, `${oos.brier!.toFixed(4)} vs ${oos.brier_climatology!.toFixed(4)}`, "< climatology"),
    g("Calibration error", oos.ece! < 0.08, oos.ece!.toFixed(3), "< 0.080"),
    g("Positive risk-adjusted return", oos.strategy_sharpe! > 0.5, oos.strategy_sharpe!.toFixed(2), "Sharpe > 0.5"),
    g("Enough out-of-sample trades", oos.strategy_trades! >= 20, String(oos.strategy_trades), "≥ 20"),
    g("Consistent across folds", consistency >= 0.6, `${(consistency * 100).toFixed(0)}% of folds`, "≥ 60% beat buy & hold"),
    g("Plausible performance", oos.strategy_sharpe! <= 4 && oos.auc! <= 0.75, `Sharpe ${oos.strategy_sharpe!.toFixed(1)}, AUC ${oos.auc!.toFixed(2)}`, "Sharpe ≤ 4 and AUC ≤ 0.75"),
    g("Trained on real market data", source !== "synthetic", source, "not synthetic"),
  ];
  return { oos, baselines, folds, calibration: cal.table, curves, gates, eligible: gates.every((x) => x.passed) };
}

// ---- drift (PSI) ------------------------------------------------------------------------
const quantile = (s: number[], q: number) => { const pos = (s.length - 1) * q, lo = Math.floor(pos); return s[lo]! + (s[Math.min(lo + 1, s.length - 1)]! - s[lo]!) * (pos - lo); };
const bucket = (edges: number[], v: number) => { let k = 0; while (k < edges.length && v >= edges[k]!) k++; return k; };
export function reference(X: number[][]) {
  return Object.fromEntries(FEATURES.map((f, j) => {
    const col = X.map((r) => r[j]!).sort((a, b) => a - b);
    const edges = [...new Set([1, 2, 3, 4, 5, 6, 7, 8, 9].map((k) => quantile(col, k / 10)))];
    const counts = new Array(edges.length + 1).fill(0); for (const v of col) counts[bucket(edges, v)]++;
    return [f, { edges, expected: counts.map((c) => c / col.length) }];
  }));
}
export function drift(ref: ReturnType<typeof reference>, X: number[][], recentBrier: number, oosBrier: number) {
  const psi = Object.fromEntries(FEATURES.map((f, j) => {
    const r = ref[f]!, counts = new Array(r.edges.length + 1).fill(0);
    for (const row of X) counts[bucket(r.edges, row[j]!)]++;
    const v = counts.reduce((s, c, k) => { const a = Math.max(c / X.length, 1e-4), e = Math.max(r.expected[k]!, 1e-4); return s + (a - e) * Math.log(a / e); }, 0);
    return [f, +v.toFixed(4)];
  }));
  const severe = FEATURES.filter((f) => psi[f]! > 0.25), moderate = FEATURES.filter((f) => psi[f]! > 0.1 && psi[f]! <= 0.25);
  const decay = (recentBrier - oosBrier) / oosBrier, reasons: string[] = [];
  if (severe.length >= 2) reasons.push(`significant shift in ${severe.length} features (${severe.slice(0, 4).join(", ")})`);
  if (decay > 0.2) reasons.push(`recent Brier score ${(decay * 100).toFixed(0)}% worse than out-of-sample`);
  const status = reasons.length ? "drift" : severe.length || moderate.length ? "warning" : "ok";
  if (status === "warning") reasons.push(`moderate shift in ${severe.length + moderate.length} feature(s)`);
  return { status, reasons, psi, max_psi: Math.max(...Object.values(psi)), recent_brier: r5(recentBrier), oos_brier: oosBrier, brier_change: +decay.toFixed(4) };
}
