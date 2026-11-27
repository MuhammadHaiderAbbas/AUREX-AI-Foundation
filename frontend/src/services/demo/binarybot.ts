/** Browser port of backend/app/binary/bot.py compute_signal: fit, validate out of sample, predict. Keep in sync. */
import { buildDataset, featureMatrix, fitLogit, predict, type Bar } from "./ml";

export const EXPIRY_BARS: Record<number, [string, number]> = { 60: ["1m", 1], 300: ["5m", 1], 900: ["15m", 1], 3600: ["1h", 1], 86400: ["1h", 24] };
const MIN_HOLDOUT = 30;

export interface Signal {
  trade: boolean; direction: "HIGHER" | "LOWER" | null; p_up: number | null; confidence: number | null;
  holdout_accuracy: number | null; holdout_n: number; train_n: number; break_even: number; required_accuracy: number;
  confidence_threshold: number; expected_return: number | null; reason: string;
}

export function computeSignal(bars: Bar[], horizon: number, payout: number, minConfidence: number, edgeMargin: number): Signal {
  const breakEven = 1 / (1 + payout), threshold = Math.max(minConfidence, breakEven), required = breakEven + edgeMargin;
  const out: Signal = { trade: false, direction: null, p_up: null, confidence: null, holdout_accuracy: null, holdout_n: 0, train_n: 0,
    break_even: breakEven, required_accuracy: required, confidence_threshold: threshold, expected_return: null, reason: "" };
  const ds = buildDataset(bars, horizon), n = ds.y.length;
  if (n < 200) return { ...out, reason: `not enough history: ${n} usable bars (need 200)` };
  const split = Math.floor(n * 0.7), trEnd = split - horizon;
  const yTr = ds.y.slice(0, trEnd);
  if (new Set(yTr).size < 2) return { ...out, reason: "price only moved one way in the training window" };
  let m = fitLogit(ds.X.slice(0, trEnd), yTr, 0.5, 200);
  let hits = 0, sel = 0;
  for (let i = split; i < n; i++) {
    const p = predict(m, ds.X[i]!);
    if (Math.max(p, 1 - p) < threshold) continue;
    sel++; if ((p >= 0.5 ? 1 : 0) === ds.y[i]) hits++;
  }
  const acc = sel ? hits / sel : null;
  out.holdout_n = sel; out.holdout_accuracy = acc; out.train_n = trEnd;
  m = fitLogit(ds.X, ds.y, 0.5, 200);
  const row = featureMatrix(bars).at(-1)!;
  if (!row.every(Number.isFinite)) return { ...out, reason: "latest bar has incomplete features" };
  const p = predict(m, row), conf = Math.max(p, 1 - p);
  Object.assign(out, { p_up: p, confidence: conf, direction: p >= 0.5 ? "HIGHER" : "LOWER", expected_return: acc == null ? null : acc * payout - (1 - acc) });
  const pc = (v: number) => `${(v * 100).toFixed(1)}%`;
  if (sel < MIN_HOLDOUT) out.reason = `too few confident out-of-sample predictions to judge (${sel} < ${MIN_HOLDOUT})`;
  else if (acc! < required) out.reason = `no validated edge: out-of-sample hit rate ${pc(acc!)} < ${pc(required)} needed`;
  else if (conf < threshold) out.reason = `not confident enough now: ${pc(conf)} < ${pc(threshold)}`;
  else { out.trade = true; out.reason = `edge validated: ${pc(acc!)} out-of-sample hit rate on ${sel} confident calls; now ${pc(conf)} ${out.direction}`; }
  return out;
}
