/**
 * Browser port of backend app/futures (book.py, service.py maths, signal.py). Keep in sync.
 * Order books: Coinbase's public level-2 book (CORS-enabled, cached 2 s); a labelled synthetic book otherwise.
 */
import { buildDataset, featureMatrix, fitLogit, predict, type Bar } from "./ml";

export const CONFIG = { max_leverage: 10, taker_fee: 0.0005, maintenance_margin: 0.005, funding_rate_8h: 0.0001, funding_interval_hours: 8,
  max_margin_pct: 20, max_total_margin_pct: 50, max_open: 5, minimum_margin: "1.00" };
export type Level = [number, number];
export interface Book { bids: Level[]; asks: Level[]; source: string }
export interface Fill { quantity: number; avg_price: number; best_price: number; worst_price: number; levels: number; slippage_bps: number }

const REST = "https://api.exchange.coinbase.com";
const cache = new Map<string, { at: number; book: Book }>();

export function syntheticBook(bid: number, ask: number): Book {
  const mid = (bid + ask) / 2, bids: Level[] = [], asks: Level[] = [];
  for (let i = 0; i < 40; i++) {
    const size = +((25000 * (1 + i * 0.35)) / mid).toFixed(8);
    bids.push([bid * (1 - 0.0002 * i), size]); asks.push([ask * (1 + 0.0002 * i), size]);
  }
  return { bids, asks, source: "synthetic" };
}

/** Live Coinbase book for a crypto product; falls back to a synthetic book around the quote. */
export async function book(symbol: string, live: boolean, bid: number, ask: number): Promise<Book> {
  const hit = cache.get(symbol);
  if (hit && Date.now() - hit.at < 2000) return hit.book;
  let b: Book | null = null;
  if (live && typeof fetch !== "undefined") {
    try {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 4000);
      const r = await fetch(`${REST}/products/${symbol}/book?level=2`, { signal: ctl.signal, headers: { Accept: "application/json" } }).finally(() => clearTimeout(t));
      if (r.ok) {
        const j = await r.json() as { bids: [string, string, number][]; asks: [string, string, number][] };
        const conv = (x: [string, string, number][]) => x.slice(0, 50).map(([p, q]) => [+p, +q] as Level);
        if (j.bids?.length && j.asks?.length) b = { bids: conv(j.bids), asks: conv(j.asks), source: "coinbase" };
      }
    } catch { /* offline or blocked: synthetic */ }
  }
  b ??= syntheticBook(bid, ask);
  cache.set(symbol, { at: Date.now(), book: b });
  return b;
}

export function walk(levels: Level[], qty: number): Fill | null {
  if (!levels.length || qty <= 0) return null;
  let left = qty, cost = 0, used = 0, worst = levels[0]![0];
  for (const [p, s] of levels) {
    const take = Math.min(left, s);
    cost += take * p; left -= take; used++; worst = p;
    if (left <= 1e-12) break;
  }
  if (left > 1e-12) return null;
  const avg = cost / qty, best = levels[0]![0];
  return { quantity: qty, avg_price: avg, best_price: best, worst_price: worst, levels: used, slippage_bps: (Math.abs(avg - best) / best) * 10000 };
}

export const sign = (side: string) => (side === "LONG" ? 1 : -1);
export function liquidationPrice(side: string, entry: number, qty: number, marginQ: number, mmr = CONFIG.maintenance_margin) {
  const cushion = (marginQ - mmr * entry * qty) / qty;
  return side === "LONG" ? Math.max(0, entry - cushion) : entry + cushion;
}
export function nextFunding(ms: number) {
  const d = new Date(ms); d.setUTCMinutes(0, 0, 0);
  const h = 8 - (d.getUTCHours() % 8);
  return d.getTime() + h * 3600e3;
}

// ---- AI model (mirror of signal.py) --------------------------------------------------
const HORIZON = 4, MIN_TRADES = 40, FOLDS = 5, CONFIDENCE = 0.55;
export const SIGNAL_BARS = 2000;

function atr(b: Bar[], n = 14) {
  const tr: number[] = [];
  for (let i = 1; i < b.length; i++) tr.push(Math.max(b[i]!.h - b[i]!.l, Math.abs(b[i]!.h - b[i - 1]!.c), Math.abs(b[i]!.l - b[i - 1]!.c)));
  if (!tr.length) return 0;
  let v = tr.slice(0, n).reduce((a, x) => a + x, 0) / Math.min(n, tr.length);
  for (const x of tr.slice(n)) v = (v * (n - 1) + x) / n;
  return v;
}

export function computeSignal(bars: Bar[], fee = CONFIG.taker_fee, funding8h = CONFIG.funding_rate_8h, maxLev = CONFIG.max_leverage) {
  const cost = 2 * fee + (funding8h * HORIZON) / 8;
  const out: Record<string, any> = { trade: false, direction: null, p_up: null, confidence: null, trades: 0, hit_rate: null, mean_return: null, // eslint-disable-line @typescript-eslint/no-explicit-any
    return_lower: null, folds: 0, folds_profitable: 0, cost_per_trade: cost, suggested_leverage: null, stop_distance_pct: null, horizon_hours: HORIZON, reason: "" };
  if (bars.length <= 80 + HORIZON + 300) return { ...out, reason: `not enough history (${bars.length} hourly bars)` };
  const ds = buildDataset(bars, HORIZON), n = ds.y.length, start = Math.floor(n * 0.5), size = Math.floor((n - start) / FOLDS);
  const rets: number[] = [], foldMeans: number[] = [];
  let hits = 0;
  for (let k = 0; k < FOLDS; k++) {
    const s0 = start + k * size, e0 = k === FOLDS - 1 ? n : s0 + size, trEnd = s0 - HORIZON;
    const yTr = ds.y.slice(0, trEnd);
    if (new Set(yTr).size < 2) continue;
    const m = fitLogit(ds.X.slice(0, trEnd), yTr, 0.5, 200);
    const fold: number[] = [];
    for (let i = s0; i < e0; i += HORIZON) {
      const p = predict(m, ds.X[i]!);
      if (Math.max(p, 1 - p) < CONFIDENCE) continue;
      const r = (p >= 0.5 ? 1 : -1) * ds.fwd[i]! - cost;
      fold.push(r); if (r > 0) hits++;
    }
    rets.push(...fold);
    if (fold.length >= 5) foldMeans.push(fold.reduce((a, x) => a + x, 0) / fold.length);
  }
  const t = rets.length;
  if (t) {
    const mean = rets.reduce((a, x) => a + x, 0) / t;
    const sd = t > 1 ? Math.sqrt(rets.reduce((a, x) => a + (x - mean) ** 2, 0) / (t - 1)) : 0;
    Object.assign(out, { trades: t, hit_rate: hits / t, mean_return: mean, return_lower: mean - (1.96 * sd) / Math.sqrt(t), folds: foldMeans.length,
      folds_profitable: foldMeans.filter((x) => x > 0).length });
  }
  const m = fitLogit(ds.X, ds.y, 0.5, 200);
  const row = featureMatrix(bars).at(-1)!;
  if (!row.every(Number.isFinite)) return { ...out, reason: "latest bar has incomplete features" };
  const p = predict(m, row), conf = Math.max(p, 1 - p);
  const move = (atr(bars) / bars.at(-1)!.c) * Math.sqrt(HORIZON);
  const lev = Math.max(1, Math.min(5, maxLev, Math.floor(0.25 / Math.max(2 * move, 1e-6))));
  Object.assign(out, { p_up: p, confidence: conf, direction: p >= 0.5 ? "LONG" : "SHORT", suggested_leverage: lev, stop_distance_pct: 2 * move * 100 });
  const need = Math.max(3, Math.ceil(0.75 * out.folds)), pc = (v: number) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(2)}%`;
  if (t < MIN_TRADES) out.reason = `too few confident out-of-sample trades to judge (${t} < ${MIN_TRADES})`;
  else if (out.return_lower <= 0) out.reason = `no proven edge after costs: average ${pc(out.mean_return)} per trade over ${t} trades, but the 95% range reaches ${pc(out.return_lower)}`;
  else if (out.folds_profitable < need) out.reason = `edge not consistent: ${out.folds_profitable} of ${out.folds} periods profitable (need ${need})`;
  else if (conf < CONFIDENCE) out.reason = `not confident enough now: ${(conf * 100).toFixed(0)}% < ${CONFIDENCE * 100}%`;
  else { out.trade = true; out.reason = `edge validated: ${pc(out.mean_return)} per trade after costs over ${t} out-of-sample trades (95% range from ${pc(out.return_lower)}); now ${(conf * 100).toFixed(0)}% ${out.direction}`; }
  return out;
}
