/** Browser port of backend/app/risk/engine.py (pure pre-trade rules). Keep the two in sync. */

export const DEFAULT_STOP_PCT: Record<string, number> = { CRYPTO: 5, FX: 1, STOCK: 3, ETF: 2 };
export const DEFAULTS = {
  risk_per_trade_pct: 0.5, max_position_pct: 20, max_gross_exposure_pct: 50, max_open_positions: 5,
  daily_loss_limit_pct: 2, max_drawdown_pct: 10, max_orders_per_minute: 20, price_collar_pct: 5,
  binary_max_stake_pct: 2, binary_max_open: 3,
};
export type Limits = typeof DEFAULTS;
export const CEILINGS: Limits = {
  risk_per_trade_pct: 2, max_position_pct: 50, max_gross_exposure_pct: 100, max_open_positions: 10,
  daily_loss_limit_pct: 5, max_drawdown_pct: 25, max_orders_per_minute: 60, price_collar_pct: 20,
  binary_max_stake_pct: 5, binary_max_open: 10,
};

export interface PreTrade {
  side: "BUY" | "SELL"; reduces: boolean; system_halt: string | null; kill_switch: string | null;
  daily_halted: boolean; drawdown_halted: boolean; equity: number; notional: number; risk_amount: number;
  position_after: number; exposure_after: number; open_positions_after: number; collar_through_pct: number | null;
  orders_last_minute: number;
}
export interface Check { name: string; label: string; passed: boolean; value: string; limit: string; message: string }

const pct = (part: number, whole: number) => (whole > 0 ? (part / whole) * 100 : Infinity);
const g = (n: number) => String(+n.toFixed(4));

export function evaluate(p: PreTrade, lim: Limits): Check[] {
  const out: Check[] = [];
  const add = (name: string, label: string, ok: boolean, value: string, limit: string, message: string) =>
    out.push({ name, label, passed: ok, value, limit, message: ok ? "" : message });
  const ex = p.reduces, note = "risk-reducing order";
  add("system_halt", "Platform trading halt", ex || !p.system_halt, ex && p.system_halt ? note : p.system_halt ? "halted" : "trading", "trading",
    `platform trading is halted: ${p.system_halt}`);
  add("kill_switch", "Account kill switch", ex || !p.kill_switch, ex && p.kill_switch ? note : p.kill_switch ? "engaged" : "off", "off",
    `account kill switch is engaged: ${p.kill_switch}`);
  add("daily_loss", "Daily loss breaker", ex || !p.daily_halted, p.daily_halted ? "tripped" : "ok", `${g(lim.daily_loss_limit_pct)}% of day-start equity`,
    `daily loss limit of ${g(lim.daily_loss_limit_pct)}% reached; new exposure is blocked until 00:00 UTC`);
  add("drawdown", "Drawdown breaker", ex || !p.drawdown_halted, p.drawdown_halted ? "tripped" : "ok", `${g(lim.max_drawdown_pct)}% from peak`,
    `maximum drawdown of ${g(lim.max_drawdown_pct)}% reached; new exposure is blocked until the breaker is reset`);
  const n = p.orders_last_minute + 1;
  add("order_rate", "Order rate", n <= lim.max_orders_per_minute, `${n} in 60s`, `${lim.max_orders_per_minute} per minute`,
    `abnormal activity: ${n} orders in 60 seconds (limit ${lim.max_orders_per_minute})`);
  if (p.collar_through_pct != null)
    add("price_collar", "Price collar", p.collar_through_pct <= lim.price_collar_pct, `${p.collar_through_pct.toFixed(2)}% through market`, `${g(lim.price_collar_pct)}%`,
      `limit price is ${p.collar_through_pct.toFixed(2)}% through the market (collar ${g(lim.price_collar_pct)}%)`);
  if (ex) return out;
  const rp = pct(p.risk_amount, p.equity);
  add("risk_per_trade", "Risk per trade", rp <= lim.risk_per_trade_pct + 1e-9, `${rp.toFixed(2)}% of equity`, `${g(lim.risk_per_trade_pct)}%`,
    `trade risks ${rp.toFixed(2)}% of equity to its stop (limit ${g(lim.risk_per_trade_pct)}%)`);
  const pp = pct(p.position_after, p.equity);
  add("position_size", "Position size", pp <= lim.max_position_pct + 1e-9, `${pp.toFixed(1)}% of equity`, `${g(lim.max_position_pct)}%`,
    `position would be ${pp.toFixed(1)}% of equity (limit ${g(lim.max_position_pct)}%)`);
  const ep = pct(p.exposure_after, p.equity);
  add("gross_exposure", "Gross exposure", ep <= lim.max_gross_exposure_pct + 1e-9, `${ep.toFixed(1)}% of equity`, `${g(lim.max_gross_exposure_pct)}%`,
    `gross exposure would be ${ep.toFixed(1)}% of equity (limit ${g(lim.max_gross_exposure_pct)}%)`);
  add("open_positions", "Open positions", p.open_positions_after <= lim.max_open_positions, String(p.open_positions_after), String(lim.max_open_positions),
    `maximum of ${lim.max_open_positions} open positions reached`);
  return out;
}
export const firstFailure = (c: Check[]) => c.find((x) => !x.passed)?.message ?? null;

export interface BinaryPreTrade {
  system_halt: string | null; kill_switch: string | null; daily_halted: boolean; drawdown_halted: boolean; enabled: boolean;
  equity: number; stake: number; minimum_stake: number; open_after: number; orders_last_minute: number;
}

/** Port of engine.evaluate_binary: binaries only ever add risk, so nothing is exempt. */
export function evaluateBinary(p: BinaryPreTrade, lim: Limits): Check[] {
  const out: Check[] = [];
  const add = (name: string, label: string, ok: boolean, value: string, limit: string, message: string) =>
    out.push({ name, label, passed: ok, value, limit, message: ok ? "" : message });
  const m = (v: number) => v.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  add("binary_enabled", "Binary trading enabled", p.enabled, p.enabled ? "on" : "off", "on", "binary trading is switched off for this account (Risk Centre)");
  add("system_halt", "Platform trading halt", !p.system_halt, p.system_halt ? "halted" : "trading", "trading", `platform trading is halted: ${p.system_halt}`);
  add("kill_switch", "Account kill switch", !p.kill_switch, p.kill_switch ? "engaged" : "off", "off", `account kill switch is engaged: ${p.kill_switch}`);
  add("daily_loss", "Daily loss breaker", !p.daily_halted, p.daily_halted ? "tripped" : "ok", `${g(lim.daily_loss_limit_pct)}% of day-start equity`,
    `daily loss limit of ${g(lim.daily_loss_limit_pct)}% reached; new exposure is blocked until 00:00 UTC`);
  add("drawdown", "Drawdown breaker", !p.drawdown_halted, p.drawdown_halted ? "tripped" : "ok", `${g(lim.max_drawdown_pct)}% from peak`,
    `maximum drawdown of ${g(lim.max_drawdown_pct)}% reached; new exposure is blocked until the breaker is reset`);
  const n = p.orders_last_minute + 1;
  add("order_rate", "Order rate", n <= lim.max_orders_per_minute, `${n} in 60s`, `${lim.max_orders_per_minute} per minute`,
    `abnormal activity: ${n} orders in 60 seconds (limit ${lim.max_orders_per_minute})`);
  add("minimum_stake", "Minimum stake", p.stake >= p.minimum_stake, m(p.stake), m(p.minimum_stake), `stake ${m(p.stake)} is below the minimum of ${m(p.minimum_stake)}`);
  const sp = pct(p.stake, p.equity);
  add("binary_stake", "Stake (maximum loss)", sp <= lim.binary_max_stake_pct + 1e-9, `${sp.toFixed(2)}% of equity`, `${g(lim.binary_max_stake_pct)}%`,
    `stake is ${sp.toFixed(2)}% of equity (binary limit ${g(lim.binary_max_stake_pct)}%); the whole stake is lost on a miss`);
  add("binary_open", "Open binary contracts", p.open_after <= lim.binary_max_open, String(p.open_after), String(lim.binary_max_open),
    `maximum of ${lim.binary_max_open} open binary contracts reached`);
  return out;
}
