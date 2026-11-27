/** Browser port of backend/app/binary/bot.py compute_signal: fit, validate out of sample, predict. Keep in sync. */
import { buildDataset, featureMatrix, fitLogit, predict, type Bar } from "./ml";

export const EXPIRY_BARS: Record<number, [string, number]> = { 60: ["1m", 1], 300: ["5m", 1], 900: ["15m", 1], 3600: ["1h", 1], 86400: ["1h", 24] };
const MIN_HOLDOUT = 60, MIN_USABLE = 400, FOLDS = 5;
export const EARLY_GUARD = 8;

export interface Signal {
  trade: boolean; direction: "HIGHER" | "LOWER" | null; p_up: number | null; confidence: number | null;
  holdout_accuracy: number | null; holdout_lower: number | null; holdout_n: number; train_n: number; folds: number; folds_beating: number;
  break_even: number; required_accuracy: number; confidence_threshold: number; expected_return: number | null; reason: string;
}

/** 95% Wilson interval for a hit rate (mirrors bot.py wilson_bounds). */
export function wilson(hits: number, n: number, z = 1.96): [number, number] {
  if (!n) return [0, 1];
  const p = hits / n, c = (p + (z * z) / (2 * n)) / (1 + (z * z) / n);
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / (1 + (z * z) / n);
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

/** Walk-forward validation with a confidence bound and a consistency check (mirrors bot.py compute_signal). */
export function computeSignal(bars: Bar[], horizon: number, payout: number, minConfidence: number, edgeMargin: number): Signal {
  const breakEven = 1 / (1 + payout), threshold = Math.max(minConfidence, breakEven), required = breakEven + edgeMargin;
  const out: Signal = { trade: false, direction: null, p_up: null, confidence: null, holdout_accuracy: null, holdout_lower: null, holdout_n: 0, train_n: 0,
    folds: 0, folds_beating: 0, break_even: breakEven, required_accuracy: required, confidence_threshold: threshold, expected_return: null, reason: "" };
  const ds = buildDataset(bars, horizon), n = ds.y.length;
  if (n < MIN_USABLE) return { ...out, reason: `not enough history: ${n} usable bars (need ${MIN_USABLE})` };
  const start = Math.floor(n * 0.5), size = Math.floor((n - start) / FOLDS);
  let hits = 0, picks = 0;
  const rates: number[] = [];
  for (let k = 0; k < FOLDS; k++) {
    const s0 = start + k * size, e0 = k === FOLDS - 1 ? n : s0 + size, trEnd = s0 - horizon;
    const yTr = ds.y.slice(0, trEnd);
    if (new Set(yTr).size < 2) continue;
    const m = fitLogit(ds.X.slice(0, trEnd), yTr, 0.5, 200);
    let fh = 0, fp = 0;
    for (let i = s0; i < e0; i++) {
      const p = predict(m, ds.X[i]!);
      if (Math.max(p, 1 - p) < threshold) continue;
      fp++; if ((p >= 0.5 ? 1 : 0) === ds.y[i]) fh++;
    }
    hits += fh; picks += fp;
    if (fp >= 5) rates.push(fh / fp);
  }
  const acc = picks ? hits / picks : null, [lower] = wilson(hits, picks), beating = rates.filter((r) => r > breakEven).length;
  Object.assign(out, { holdout_n: picks, holdout_accuracy: acc, holdout_lower: picks ? lower : null, train_n: start - horizon, folds: rates.length, folds_beating: beating });
  const m = fitLogit(ds.X, ds.y, 0.5, 200);
  const row = featureMatrix(bars).at(-1)!;
  if (!row.every(Number.isFinite)) return { ...out, reason: "latest bar has incomplete features" };
  const p = predict(m, row), conf = Math.max(p, 1 - p);
  Object.assign(out, { p_up: p, confidence: conf, direction: p >= 0.5 ? "HIGHER" : "LOWER", expected_return: acc == null ? null : acc * payout - (1 - acc) });
  const pc = (v: number) => `${(v * 100).toFixed(1)}%`, needFolds = Math.max(3, Math.ceil(0.75 * rates.length));
  if (picks < MIN_HOLDOUT) out.reason = `too few confident out-of-sample predictions to judge (${picks} < ${MIN_HOLDOUT})`;
  else if (lower < breakEven) out.reason = `no proven edge: hit rate ${pc(acc!)} on ${picks} out-of-sample calls, but the 95% range starts at ${pc(lower)}, below the ${pc(breakEven)} break-even`;
  else if (acc! < required) out.reason = `no validated edge: out-of-sample hit rate ${pc(acc!)} < ${pc(required)} needed`;
  else if (beating < needFolds) out.reason = `edge not consistent: only ${beating} of ${rates.length} time periods beat break-even (need ${needFolds})`;
  else if (conf < threshold) out.reason = `not confident enough now: ${pc(conf)} < ${pc(threshold)}`;
  else { out.trade = true; out.reason = `edge validated: ${pc(acc!)} hit rate (95% range from ${pc(lower)}) on ${picks} out-of-sample calls, ${beating}/${rates.length} periods above break-even; now ${pc(conf)} ${out.direction}`; }
  return out;
}
