/** Browser port of backend/app/analytics/metrics.py. Keep the two in sync. */

export const ANNUAL = 365;
export const MIN_PERIODS = 20;
const DAY = 86_400_000;
const dayOf = (t: string) => t.slice(0, 10);

export function dailyPoints(points: [string, number][]): [string, number][] {
  if (!points.length) return [];
  const byDay = new Map<string, number>();
  for (const [t, e] of [...points].sort((a, b) => a[0].localeCompare(b[0]))) byDay.set(dayOf(t), e);
  const days = [...byDay.keys()].sort();
  const out: [string, number][] = [];
  let last = byDay.get(days[0]!)!;
  for (let t = Date.parse(`${days[0]}T00:00:00Z`); t <= Date.parse(`${days.at(-1)}T00:00:00Z`); t += DAY) {
    const d = new Date(t).toISOString().slice(0, 10);
    last = byDay.get(d) ?? last;
    out.push([d, last]);
  }
  return out;
}

export function dailyReturns(days: [string, number][], flows: Record<string, number>): [string, number][] {
  const out: [string, number][] = [];
  for (let i = 1; i < days.length; i++) {
    const prev = days[i - 1]![1], [d, eq] = days[i]!;
    if (prev > 0) out.push([d, (eq - (flows[d] ?? 0)) / prev - 1]);
  }
  return out;
}

const std = (xs: number[]) => {
  if (xs.length < 2) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
};

export function drawdowns(values: number[]): number[] {
  let peak = -Infinity;
  return values.map((v) => { peak = Math.max(peak, v); return peak > 0 ? v / peak - 1 : 0; });
}

export function performance(rets: number[]) {
  const n = rets.length;
  const growth = [1];
  for (const r of rets) growth.push(growth.at(-1)! * (1 + r));
  const dd = drawdowns(growth);
  const maxDd = Math.min(...dd);
  let longest = 0, cur = 0;
  for (const x of dd) { cur = x < 0 ? cur + 1 : 0; longest = Math.max(longest, cur); }
  const enough = n >= MIN_PERIODS;
  const mean = n ? rets.reduce((a, b) => a + b, 0) / n : 0;
  const vol = std(rets);
  const downside = n ? Math.sqrt(rets.reduce((a, r) => a + Math.min(r, 0) ** 2, 0) / n) : 0;
  const years = n / ANNUAL;
  const cagr = enough && years > 0 && growth.at(-1)! > 0 ? growth.at(-1)! ** (1 / years) - 1 : null;
  return {
    periods: n, total_return: growth.at(-1)! - 1, cagr,
    volatility: enough ? vol * Math.sqrt(ANNUAL) : null,
    sharpe: enough && vol > 0 ? (mean / vol) * Math.sqrt(ANNUAL) : null,
    sortino: enough && downside > 0 ? (mean / downside) * Math.sqrt(ANNUAL) : null,
    max_drawdown: maxDd, max_drawdown_days: longest,
    calmar: cagr != null && maxDd < 0 ? cagr / -maxDd : null,
    best_day: n ? Math.max(...rets) : null, worst_day: n ? Math.min(...rets) : null,
    positive_days: n ? rets.filter((r) => r > 0).length / n : null,
  };
}

export interface Trade { symbol: string; asset_class: string; source: string; exit: string; opened_at: string; closed_at: string; pnl: number; fees: number; cost: number }

export function tradeStats(ts: Trade[]) {
  const n = ts.length;
  const wins = ts.filter((t) => t.pnl > 0).map((t) => t.pnl), losses = ts.filter((t) => t.pnl <= 0).map((t) => t.pnl);
  const gw = wins.reduce((a, b) => a + b, 0), gl = -losses.reduce((a, b) => a + b, 0);
  const avgWin = wins.length ? gw / wins.length : 0, avgLoss = losses.length ? -gl / losses.length : 0;
  const net = ts.reduce((a, t) => a + t.pnl, 0), cost = ts.reduce((a, t) => a + t.cost, 0);
  const hold = ts.map((t) => (Date.parse(t.closed_at) - Date.parse(t.opened_at)) / 3600e3);
  return {
    trades: n, wins: wins.length, losses: losses.length, win_rate: n ? wins.length / n : null, net_pnl: net,
    fees: ts.reduce((a, t) => a + t.fees, 0), profit_factor: gl > 0 ? gw / gl : null, avg_win: avgWin, avg_loss: avgLoss,
    payoff_ratio: avgLoss < 0 ? avgWin / -avgLoss : null, expectancy: n ? net / n : null,
    best: n ? Math.max(...ts.map((t) => t.pnl)) : null, worst: n ? Math.min(...ts.map((t) => t.pnl)) : null,
    avg_hold_hours: n ? hold.reduce((a, b) => a + b, 0) / n : null, return_on_cost: n && cost ? net / cost : null,
    no_losses: n > 0 && losses.length === 0,
  };
}

export function groupStats(ts: Trade[], key: keyof Trade) {
  const groups = new Map<string, Trade[]>();
  for (const t of ts) groups.set(String(t[key]), [...(groups.get(String(t[key])) ?? []), t]);
  return [...groups].map(([k, v]) => { const s = tradeStats(v); return { key: k, trades: s.trades, win_rate: s.win_rate, net_pnl: s.net_pnl, profit_factor: s.profit_factor, expectancy: s.expectancy }; })
    .sort((a, b) => b.net_pnl - a.net_pnl);
}

export function calibration(pairs: [number, boolean][], bins = 5) {
  if (!pairs.length) return { n: 0, brier: null, ece: null, bins: [] as { lo: number; hi: number; n: number; confidence: number; hit_rate: number }[] };
  const out = []; let ece = 0;
  for (let b = 0; b < bins; b++) {
    const lo = b / bins, hi = (b + 1) / bins;
    const sel = pairs.filter(([c]) => (c >= lo && c < hi) || (b === bins - 1 && c === 1));
    if (!sel.length) continue;
    const conf = sel.reduce((a, [c]) => a + c, 0) / sel.length, hit = sel.filter(([, y]) => y).length / sel.length;
    ece += (sel.length / pairs.length) * Math.abs(conf - hit);
    out.push({ lo, hi, n: sel.length, confidence: conf, hit_rate: hit });
  }
  return { n: pairs.length, brier: pairs.reduce((a, [c, y]) => a + (c - (y ? 1 : 0)) ** 2, 0) / pairs.length, ece, bins: out };
}
