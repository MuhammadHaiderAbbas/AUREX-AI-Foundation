/**
 * Browser port of backend/app/backtest (event-driven engine, strategies, IS/OOS evaluation)
 * for the static demo. Same event order, cost model, risk limits and protocol.
 */
import * as ag from "./agents";
import { rsi, sma } from "./market";

export interface Bars { t: string[]; o: number[]; h: number[]; l: number[]; c: number[] }
export interface Costs { fee_bps: number; half_spread_bps: number; slippage_bps: number; vol_slippage: number; latency_bars: number }
export const DEFAULT_COSTS: Record<string, Costs> = {
  CRYPTO: { fee_bps: 10, half_spread_bps: 1, slippage_bps: 2, vol_slippage: 0.1, latency_bars: 1 },
  FX: { fee_bps: 0, half_spread_bps: 0.3, slippage_bps: 0.5, vol_slippage: 0.1, latency_bars: 1 },
  STOCK: { fee_bps: 1, half_spread_bps: 1, slippage_bps: 2, vol_slippage: 0.1, latency_bars: 1 },
  ETF: { fee_bps: 1, half_spread_bps: 0.5, slippage_bps: 1, vol_slippage: 0.1, latency_bars: 1 },
};
export interface Risk { risk_per_trade: number; max_position_pct: number; stop_atr: number; target_atr: number; daily_loss_limit: number; max_drawdown: number }
export const RISK: Risk = { risk_per_trade: 0.005, max_position_pct: 0.2, stop_atr: 2, target_atr: 3, daily_loss_limit: 0.02, max_drawdown: 0.1 };
const BENCH: Risk = { risk_per_trade: 1e9, max_position_pct: 0.998, stop_atr: 1e9, target_atr: 1e9, daily_loss_limit: 1, max_drawdown: 1 };
const BPY: Record<string, number> = { CRYPTO: 8760, FX: 6240, STOCK: 1764, ETF: 1764 };

interface Strategy { key: string; warmup: number; prepare(b: Bars): void; signal(i: number, inPos: boolean): "enter" | "exit" | null }
interface Trade { entry_time: string; entry_price: number; qty: number; entry_fee: number; stop: number; target: number; entry_index: number; exit_time?: string; exit_price?: number; exit_fee: number; exit_reason: string; exit_index?: number }
const pnl = (t: Trade) => ((t.exit_price ?? 0) - t.entry_price) * t.qty - t.entry_fee - t.exit_fee;

function atr(b: Bars, n = 14) {
  const tr = b.c.map((_, i) => { const p = i ? b.c[i - 1]! : b.c[0]!; return Math.max(b.h[i]! - b.l[i]!, Math.abs(b.h[i]! - p), Math.abs(b.l[i]! - p)); });
  const out = new Array(b.c.length).fill(NaN);
  if (b.c.length > n) { out[n] = tr.slice(1, n + 1).reduce((x, y) => x + y, 0) / n; for (let i = n + 1; i < b.c.length; i++) out[i] = (out[i - 1] * (n - 1) + tr[i]!) / n; }
  return out as number[];
}

export function run(b: Bars, s: Strategy, costs: Costs, risk: Risk, capital = 100_000, start0?: number, end0?: number, lot = 1e-8) {
  const n = b.c.length, start = Math.max(s.warmup, start0 ?? 0), end = end0 == null ? n : Math.min(end0, n);
  if (end - start < 20) throw new Error("Backtest window is too short");
  s.prepare(b);
  const a = atr(b), rets = b.c.map((v, i) => (i ? Math.log(v / b.c[i - 1]!) : 0));
  const sigma = b.c.map((_, i) => { if (i <= 2) return 0; const w = rets.slice(Math.max(1, i - 20), i); const m = w.reduce((x, y) => x + y, 0) / w.length; return Math.sqrt(w.reduce((x, y) => x + (y - m) ** 2, 0) / w.length); });
  const half = costs.half_spread_bps / 1e4, fee = costs.fee_bps / 1e4;
  let cash = capital, pos: Trade | null = null, peak = capital, fees = 0, slipCost = 0, notional = 0, day = "", dayStart = capital, dayHalt = false, halted = false;
  const pending: [number, "enter" | "exit", number][] = [], trades: Trade[] = [], events: { time: string; type: string; detail: string }[] = [];
  const equity: number[] = [], inPos: boolean[] = [];
  const slip = (i: number) => costs.slippage_bps / 1e4 + costs.vol_slippage * sigma[i - 1]!;
  const close = (i: number, raw: number, reason: string) => {
    const px = raw * (1 - half - slip(i)), f = px * pos!.qty * fee;
    cash += px * pos!.qty - f; fees += f; slipCost += (raw - px) * pos!.qty; notional += px * pos!.qty;
    Object.assign(pos!, { exit_time: b.t[i], exit_price: px, exit_fee: f, exit_reason: reason, exit_index: i });
    trades.push(pos!); pos = null;
  };
  for (let i = start; i < end; i++) {
    const o = b.o[i]!, h = b.h[i]!, lo = b.l[i]!, c = b.c[i]!;
    for (const ord of pending.filter((p) => p[0] <= i)) {
      pending.splice(pending.indexOf(ord), 1);
      if (ord[1] === "enter" && !pos && !halted) {
        const px = o * (1 + half + slip(i));
        let qty = Math.min(ord[2], cash / (px * (1 + fee)));
        qty = Math.floor(qty / lot) * lot;
        if (qty <= 0) continue;
        const f = px * qty * fee;
        cash -= px * qty + f; fees += f; slipCost += (px - o) * qty; notional += px * qty;
        pos = { entry_time: b.t[i]!, entry_price: px, qty, entry_fee: f, stop: px - a[i - 1]! * risk.stop_atr, target: px + a[i - 1]! * risk.target_atr, entry_index: i, exit_fee: 0, exit_reason: "" };
      } else if (ord[1] === "exit" && pos) close(i, o, "signal");
    }
    if (pos) { if (lo <= pos.stop) close(i, Math.min(o, pos.stop), "stop"); else if (h >= pos.target) close(i, Math.max(o, pos.target), "target"); }
    const eq = cash + (pos ? pos.qty * c * (1 - half) : 0);
    equity.push(eq); inPos.push(!!pos); peak = Math.max(peak, eq);
    const d = b.t[i]!.slice(0, 10);
    if (d !== day) { day = d; dayStart = eq; dayHalt = false; }
    if (!dayHalt && eq < dayStart * (1 - risk.daily_loss_limit)) { dayHalt = true; events.push({ time: b.t[i]!, type: "daily_loss_limit", detail: `equity ${((eq / dayStart - 1) * 100).toFixed(2)}% on the day; no new entries until tomorrow` }); }
    if (!halted && eq < peak * (1 - risk.max_drawdown)) {
      halted = true; pending.length = 0;
      events.push({ time: b.t[i]!, type: "max_drawdown_halt", detail: `drawdown ${((1 - eq / peak) * 100).toFixed(2)}% breached the ${risk.max_drawdown * 100}% limit; position flattened and strategy halted` });
      if (pos) pending.push([i + costs.latency_bars, "exit", pos.qty]);
    }
    if (i < end - costs.latency_bars && !pending.some((p) => p[1] === "exit")) {
      const sig = s.signal(i, !!pos);
      if (sig === "enter" && !pos && !pending.length && !halted && !dayHalt) {
        const stopD = a[i]! * risk.stop_atr;
        if (Number.isFinite(stopD) && stopD > 0) pending.push([i + costs.latency_bars, "enter", Math.min((eq * risk.risk_per_trade) / stopD, (eq * risk.max_position_pct) / c)]);
      } else if (sig === "exit" && pos) pending.push([i + costs.latency_bars, "exit", pos.qty]);
    }
  }
  if (pos) { close(end - 1, b.c[end - 1]!, "end_of_test"); equity[equity.length - 1] = cash; }
  return { equity, inPos, trades, events, start, fees, slipCost, notional, halted };
}

// ---- strategies --------------------------------------------------------------------
const arr = (v: (number | null)[]) => v.map((x) => (x == null ? NaN : x));
function makeStrategy(key: string, p: Record<string, number>): Strategy {
  if (key === "sma_crossover") {
    let f: number[] = [], s: number[] = [];
    return { key, warmup: p.slow! + 2, prepare: (b) => { f = arr(sma(b.c, p.fast!)); s = arr(sma(b.c, p.slow!)); },
      signal: (i, inPos) => (inPos ? (f[i]! < s[i]! ? "exit" : null) : f[i]! > s[i]! && f[i - 1]! <= s[i - 1]! ? "enter" : null) };
  }
  if (key === "rsi_reversion") {
    let r: number[] = [];
    return { key, warmup: p.period! + 2, prepare: (b) => { r = arr(rsi(b.c, p.period!)); },
      signal: (i, inPos) => (inPos ? (r[i]! > p.exit! ? "exit" : null) : r[i]! < p.entry! && r[i - 1]! >= p.entry! ? "enter" : null) };
  }
  if (key === "donchian_breakout") {
    let hi: number[] = [], lo: number[] = [], c: number[] = [];
    const lb = p.lookback!, ex = Math.max(2, Math.floor(lb / 2));
    return { key, warmup: lb + 2,
      prepare: (b) => { c = b.c; hi = b.c.map((_, i) => (i >= lb ? Math.max(...b.h.slice(i - lb, i)) : NaN)); lo = b.c.map((_, i) => (i >= lb ? Math.min(...b.l.slice(i - ex, i)) : NaN)); },
      signal: (i, inPos) => (inPos ? (c[i]! < lo[i]! ? "exit" : null) : c[i]! > hi[i]! ? "enter" : null) };
  }
  // agent_consensus: Phase 5 technical + quant on a rolling 200-bar window, every 4 bars
  let bars: Bars; const cache = new Map<number, number>();
  const net = (i: number) => {
    if (cache.has(i)) return cache.get(i)!;
    const h1 = bars.t.slice(i - 199, i + 1).map((t, k) => ({ t, o: bars.o[i - 199 + k]!, h: bars.h[i - 199 + k]!, l: bars.l[i - 199 + k]!, c: bars.c[i - 199 + k]! }));
    const ctx = { symbol: "BT", asset_class: "CRYPTO", quote_currency: "USD", price_decimals: 8, lot_size: 1, now: 0, h1, d1: [], quote: null, docs: [], macro: [], account: null, fx: null, open_positions: 0 } as ag.Ctx;
    const w = [ag.technical(ctx), ag.quant(ctx)].filter((f) => f.status === "ok").map((f) => [0.35 * f.confidence, f.score] as const);
    const tot = w.reduce((s, [x]) => s + x, 0), v = tot ? w.reduce((s, [x, y]) => s + x * y, 0) / tot : 0;
    cache.set(i, v); return v;
  };
  return { key, warmup: 200, prepare: (b) => { bars = b; cache.clear(); },
    signal: (i, inPos) => (i % 4 ? null : inPos ? (net(i) < 0 ? "exit" : null) : net(i) >= p.min_net! ? "enter" : null) };
}

export const STRATEGIES = [
  { key: "sma_crossover", name: "SMA crossover", description: "Enter when the fast SMA crosses above the slow SMA; exit when it falls back below.", defaults: { fast: 20, slow: 50 },
    params: { fast: { type: "int", min: 2, max: 100 }, slow: { type: "int", min: 5, max: 300 } }, grid: [10, 20, 30].flatMap((f) => [50, 100].map((s) => ({ fast: f, slow: s }))) },
  { key: "rsi_reversion", name: "RSI mean reversion", description: "Buy when RSI drops through the entry level; sell when it recovers above the exit level.", defaults: { period: 14, entry: 30, exit: 55 },
    params: { period: { type: "int", min: 2, max: 50 }, entry: { type: "float", min: 5, max: 50 }, exit: { type: "float", min: 30, max: 95 } }, grid: [25, 30, 35].flatMap((e) => [50, 60].map((x) => ({ period: 14, entry: e, exit: x }))) },
  { key: "donchian_breakout", name: "Donchian breakout", description: "Buy a close above the prior N-bar high; exit below the prior N/2-bar low.", defaults: { lookback: 48 },
    params: { lookback: { type: "int", min: 5, max: 500 } }, grid: [24, 48, 96, 168].map((n) => ({ lookback: n })) },
  { key: "agent_consensus", name: "Agent consensus (technical + quant)", description: "Replays the Phase 5 technical and quant agents every 4 bars; enters when their weighted net score clears the threshold.",
    defaults: { min_net: 0.25 }, params: { min_net: { type: "float", min: 0.05, max: 0.9 } }, grid: [0.2, 0.3].map((m) => ({ min_net: m })) },
] as const;

export function validateParams(key: string, params?: Record<string, number>) {
  const spec = STRATEGIES.find((s) => s.key === key);
  if (!spec) throw new Error("Unknown strategy");
  const merged: Record<string, number> = { ...spec.defaults, ...(params ?? {}) };
  for (const [k, v] of Object.entries(merged)) {
    const rule = (spec.params as Record<string, { type: string; min: number; max: number }>)[k];
    if (!rule) throw new Error(`Unknown parameter ${k}`);
    if (v < rule.min || v > rule.max) throw new Error(`${k} must be between ${rule.min} and ${rule.max}`);
    if (rule.type === "int") merged[k] = Math.round(v);
  }
  if (key === "sma_crossover" && merged.fast! >= merged.slow!) throw new Error("fast must be shorter than slow");
  return merged;
}

// ---- metrics & evaluation ------------------------------------------------------------
function metrics(r: ReturnType<typeof run>, asset: string, capital: number) {
  const eq = r.equity, rets = eq.slice(1).map((v, i) => v / eq[i]! - 1), ppy = BPY[asset]!, n = eq.length;
  const total = eq[n - 1]! / capital - 1, years = n / ppy, cagr = years > 0 && eq[n - 1]! > 0 ? (eq[n - 1]! / capital) ** (1 / years) - 1 : 0;
  const m = rets.reduce((s, x) => s + x, 0) / Math.max(1, rets.length);
  const sd = rets.length > 1 ? Math.sqrt(rets.reduce((s, x) => s + (x - m) ** 2, 0) / (rets.length - 1)) : 0;
  const down = rets.filter((x) => x < 0), dsd = down.length ? Math.sqrt(down.reduce((s, x) => s + x * x, 0) / down.length) : 0;
  let peak = capital, mdd = 0; for (const v of eq) { peak = Math.max(peak, v); mdd = Math.max(mdd, 1 - v / peak); }
  const p = r.trades.map(pnl), wins = p.filter((x) => x > 0), losses = p.filter((x) => x <= 0);
  const held = r.trades.filter((t) => t.exit_index != null).map((t) => t.exit_index! - t.entry_index + 1);
  const avg = (x: number[]) => (x.length ? x.reduce((a, b) => a + b, 0) / x.length : 0);
  const sl = losses.reduce((a, b) => a + b, 0);
  const R = (v: number, d: number) => +v.toFixed(d);
  return {
    total_return: R(total, 5), cagr: R(cagr, 5), volatility: R(sd * Math.sqrt(ppy), 5), sharpe: sd > 0 ? R((m / sd) * Math.sqrt(ppy), 3) : 0,
    sortino: dsd > 0 ? R((m / dsd) * Math.sqrt(ppy), 3) : 0, max_drawdown: R(mdd, 5), calmar: mdd > 0 ? R(cagr / mdd, 3) : 0,
    trades: r.trades.length, win_rate: p.length ? R(wins.length / p.length, 4) : 0, profit_factor: losses.length && sl < 0 ? R(wins.reduce((a, b) => a + b, 0) / -sl, 3) : null,
    avg_win: R(avg(wins), 2), avg_loss: R(avg(losses), 2), avg_bars_held: R(avg(held), 1), exposure: R(r.inPos.filter(Boolean).length / r.inPos.length, 4),
    turnover: R(r.notional / avg(eq), 2), fees: R(r.fees, 2), slippage_and_spread: R(r.slipCost, 2), halted: r.halted, risk_events: r.events.length, bars: n,
  };
}
const BUY_HOLD: Strategy = { key: "buy_and_hold", warmup: 1, prepare: () => undefined, signal: (_, inPos) => (inPos ? null : "enter") };

export function evaluate(b: Bars, key: string, params: Record<string, number> | undefined, asset: string, costs: Costs, capital: number, optimise: boolean, lot: number) {
  const n = b.c.length, split = Math.floor(n * 0.6), spec = STRATEGIES.find((s) => s.key === key)!;
  const go = (p: Record<string, number>, s?: number, e?: number) => run(b, makeStrategy(key, p), costs, RISK, capital, s, e, lot);
  let chosen = validateParams(key, params);
  const grid: { params: Record<string, number>; sharpe: number; total_return: number; max_drawdown: number; trades: number }[] = [];
  if (optimise) {
    let best: [number, Record<string, number>] | null = null;
    for (const combo of spec.grid as readonly Record<string, number>[]) {
      let r; try { r = go({ ...combo }, undefined, split); } catch { continue; }
      const m = metrics(r, asset, capital);
      grid.push({ params: { ...combo }, sharpe: m.sharpe, total_return: m.total_return, max_drawdown: m.max_drawdown, trades: m.trades });
      if (m.trades >= 3 && (!best || m.sharpe > best[0])) best = [m.sharpe, { ...combo }];
    }
    if (best) chosen = validateParams(key, best[1]);
  }
  const rIs = go(chosen, undefined, split), rOos = go(chosen, split), rFull = go(chosen);
  const bh = (s?: number, e?: number) => run(b, BUY_HOLD, costs, BENCH, capital, s, e, lot);
  const mIs = metrics(rIs, asset, capital), mOos = metrics(rOos, asset, capital), bIs = metrics(bh(undefined, split), asset, capital), bOos = metrics(bh(split), asset, capital);
  const bhFull = bh(rFull.start);
  const warnings: string[] = [];
  if (mIs.sharpe > 0.5 && mOos.sharpe < 0.5 * mIs.sharpe) warnings.push(`Overfitting risk: out-of-sample Sharpe ${mOos.sharpe.toFixed(2)} is far below in-sample ${mIs.sharpe.toFixed(2)}`);
  if (mOos.total_return < bOos.total_return) warnings.push("Out-of-sample the strategy underperformed buy & hold after costs");
  if (mOos.trades < 10) warnings.push(`Only ${mOos.trades} out-of-sample trades: results are statistically fragile`);
  if (rOos.halted) warnings.push("The 10% drawdown circuit breaker halted the strategy out-of-sample");
  const curve = (r: ReturnType<typeof run>) => { const k = Math.min(400, r.equity.length); return Array.from({ length: k }, (_, j) => { const i = Math.floor((j * (r.equity.length - 1)) / Math.max(1, k - 1)); return [b.t[r.start + i]!, +r.equity[i]!.toFixed(2)] as [string, number]; }); };
  return {
    params: chosen, optimised: optimise, split_time: b.t[split]!, in_sample: { strategy: mIs, buy_hold: bIs }, out_of_sample: { strategy: mOos, buy_hold: bOos },
    full: metrics(rFull, asset, capital), degradation: { sharpe: +(mOos.sharpe - mIs.sharpe).toFixed(3), total_return: +(mOos.total_return - mIs.total_return).toFixed(5) },
    grid, warnings, curves: { strategy: curve(rFull), buy_hold: curve(bhFull) },
    trades: rFull.trades.slice(-300).map((t) => ({ entry_time: t.entry_time, exit_time: t.exit_time ?? null, entry_price: t.entry_price, exit_price: t.exit_price ?? null, qty: t.qty, pnl: +pnl(t).toFixed(2),
      return: t.exit_price ? +(t.exit_price / t.entry_price - 1).toFixed(5) : null, fees: +(t.entry_fee + t.exit_fee).toFixed(2), exit_reason: t.exit_reason, bars_held: t.exit_index != null ? t.exit_index - t.entry_index + 1 : null })),
    events: rFull.events,
  };
}
