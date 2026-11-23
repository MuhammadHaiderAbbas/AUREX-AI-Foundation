"""Event-driven, bar-by-bar backtest engine.

Event order on every bar i (prevents look-ahead by construction):
  1. FILL     orders submitted at bar i - latency fill at bar i's OPEN (spread + slippage + fee)
  2. MANAGE   protective stop / target checked against bar i's range; a gap through the stop
              fills at the open (worse than the stop); if both are touched the STOP is assumed
  3. MARK     equity marked to bar i's close at the bid (liquidation value)
  4. RISK     daily-loss limit (no new entries for the rest of the UTC day) and max-drawdown
              circuit breaker (flatten and stop trading) — the blueprint development defaults
  5. SIGNAL   the strategy sees data up to bar i's close and may submit orders for later bars
Market closures need no special handling: session markets simply have no bars while closed,
so a signal at Friday's close fills at Monday's open, gap included.
"""

import math
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Protocol

import numpy as np


@dataclass(frozen=True)
class Bars:
    t: list[datetime]
    o: np.ndarray
    h: np.ndarray
    l: np.ndarray  # noqa: E741
    c: np.ndarray

    def __len__(self) -> int:
        return len(self.c)


@dataclass
class Costs:
    fee_bps: float          # commission per side, bps of notional
    half_spread_bps: float  # paid on every fill
    slippage_bps: float     # base slippage per fill
    vol_slippage: float = 0.1   # plus this fraction of the recent per-bar volatility
    latency_bars: int = 1       # bars between signal and fill (>= 1)


DEFAULT_COSTS = {
    "CRYPTO": Costs(fee_bps=10, half_spread_bps=1.0, slippage_bps=2.0),
    "FX": Costs(fee_bps=0, half_spread_bps=0.3, slippage_bps=0.5),
    "STOCK": Costs(fee_bps=1, half_spread_bps=1.0, slippage_bps=2.0),
    "ETF": Costs(fee_bps=1, half_spread_bps=0.5, slippage_bps=1.0),
}


@dataclass
class Risk:
    risk_per_trade: float = 0.005    # fraction of equity lost if the stop is hit
    max_position_pct: float = 0.20   # notional cap per position (no leverage)
    stop_atr: float = 2.0
    target_atr: float = 3.0
    daily_loss_limit: float = 0.02
    max_drawdown: float = 0.10


class Strategy(Protocol):
    key: str
    warmup: int

    def prepare(self, bars: Bars) -> None: ...
    def signal(self, i: int, in_position: bool) -> str | None: ...   # "enter" | "exit" | None


@dataclass
class Trade:
    entry_time: datetime
    entry_price: float
    qty: float
    entry_fee: float
    stop: float
    target: float
    entry_index: int
    exit_time: datetime | None = None
    exit_price: float | None = None
    exit_fee: float = 0.0
    exit_reason: str = ""
    exit_index: int | None = None
    slippage_cost: float = 0.0

    @property
    def pnl(self) -> float:
        return (self.exit_price - self.entry_price) * self.qty - self.entry_fee - self.exit_fee  # type: ignore[operator]


@dataclass
class Result:
    equity: np.ndarray
    in_position: np.ndarray
    trades: list[Trade]
    events: list[dict[str, Any]]
    start_index: int
    fees: float
    slippage: float
    traded_notional: float
    halted: bool = False
    extra: dict[str, Any] = field(default_factory=dict)


def atr(b: Bars, n: int = 14) -> np.ndarray:
    prev = np.concatenate([[b.c[0]], b.c[:-1]])
    tr = np.maximum.reduce([b.h - b.l, np.abs(b.h - prev), np.abs(b.l - prev)])
    out = np.full(len(b), np.nan)
    if len(b) > n:
        out[n] = tr[1:n + 1].mean()
        for i in range(n + 1, len(b)):
            out[i] = (out[i - 1] * (n - 1) + tr[i]) / n
    return out


def run(bars: Bars, strategy: Strategy, costs: Costs, risk: Risk, *, capital: float = 100_000.0,
        start: int | None = None, end: int | None = None, lot_size: float = 1e-8) -> Result:
    n = len(bars)
    start = max(strategy.warmup, start or 0)
    end = n if end is None else min(end, n)
    if end - start < 20:
        raise ValueError("Backtest window is too short")
    strategy.prepare(bars)
    a = atr(bars)
    rets = np.concatenate([[0.0], np.diff(np.log(bars.c))])
    sigma = np.array([rets[max(1, i - 20):i].std() if i > 2 else 0.0 for i in range(n)])
    half, fee = costs.half_spread_bps / 1e4, costs.fee_bps / 1e4

    cash, pos = capital, None
    pending: list[tuple[int, str, float]] = []   # (fill_index, side, qty)
    trades: list[Trade] = []
    events: list[dict[str, Any]] = []
    equity = np.full(end - start, np.nan)
    in_pos = np.zeros(end - start, dtype=bool)
    peak, fees_paid, slip_paid, notional = capital, 0.0, 0.0, 0.0
    day, day_start, day_halted, halted = None, capital, False, False

    def slip(i: int) -> float:
        return costs.slippage_bps / 1e4 + costs.vol_slippage * sigma[i - 1]

    def close_position(i: int, raw_price: float, reason: str) -> None:
        nonlocal cash, pos, fees_paid, slip_paid, notional
        px = raw_price * (1 - half - slip(i))
        f = px * pos.qty * fee
        cash += px * pos.qty - f
        pos.exit_time, pos.exit_price, pos.exit_fee = bars.t[i], px, f
        pos.exit_reason, pos.exit_index = reason, i
        pos.slippage_cost += (raw_price - px) * pos.qty
        fees_paid += f
        slip_paid += (raw_price - px) * pos.qty
        notional += px * pos.qty
        trades.append(pos)
        pos = None

    for i in range(start, end):
        o, h, lo, c = bars.o[i], bars.h[i], bars.l[i], bars.c[i]
        # 1. FILL ---------------------------------------------------------------------
        for order in [p for p in pending if p[0] <= i]:
            pending.remove(order)
            _, side, qty = order
            if side == "enter" and pos is None and not halted:
                px = o * (1 + half + slip(i))
                qty = min(qty, cash / (px * (1 + fee)))
                qty = math.floor(qty / lot_size) * lot_size
                if qty <= 0:
                    continue
                f = px * qty * fee
                cash -= px * qty + f
                fees_paid += f
                slip_paid += (px - o) * qty
                notional += px * qty
                stop_d = a[i - 1] * risk.stop_atr
                pos = Trade(bars.t[i], px, qty, f, px - stop_d, px + a[i - 1] * risk.target_atr, i,
                            slippage_cost=(px - o) * qty)
            elif side == "exit" and pos is not None:
                close_position(i, o, "signal")
        # 2. MANAGE -------------------------------------------------------------------
        if pos is not None:
            if lo <= pos.stop:
                close_position(i, min(o, pos.stop), "stop")
            elif h >= pos.target:
                close_position(i, max(o, pos.target), "target")
        # 3. MARK ---------------------------------------------------------------------
        eq = cash + (pos.qty * c * (1 - half) if pos else 0.0)
        equity[i - start] = eq
        in_pos[i - start] = pos is not None
        peak = max(peak, eq)
        # 4. RISK ---------------------------------------------------------------------
        d = bars.t[i].date()
        if d != day:
            day, day_start, day_halted = d, eq, False
        if not day_halted and eq < day_start * (1 - risk.daily_loss_limit):
            day_halted = True
            events.append({"time": bars.t[i].isoformat(), "type": "daily_loss_limit",
                           "detail": f"equity {eq / day_start - 1:+.2%} on the day; no new entries until tomorrow"})
        if not halted and eq < peak * (1 - risk.max_drawdown):
            halted = True
            events.append({"time": bars.t[i].isoformat(), "type": "max_drawdown_halt",
                           "detail": f"drawdown {1 - eq / peak:.2%} breached the {risk.max_drawdown:.0%} limit; "
                                     "position flattened and strategy halted"})
            pending.clear()
            if pos is not None:
                pending.append((i + costs.latency_bars, "exit", pos.qty))
        # 5. SIGNAL -------------------------------------------------------------------
        if i < end - costs.latency_bars and not any(p[1] == "exit" for p in pending):
            sig = strategy.signal(i, pos is not None)
            if sig == "enter" and pos is None and not pending and not halted and not day_halted:
                stop_d = a[i] * risk.stop_atr
                if np.isfinite(stop_d) and stop_d > 0:
                    qty = min(eq * risk.risk_per_trade / stop_d, eq * risk.max_position_pct / c)
                    pending.append((i + costs.latency_bars, "enter", qty))
            elif sig == "exit" and pos is not None:
                pending.append((i + costs.latency_bars, "exit", pos.qty))

    if pos is not None:   # mark-to-market close at the end of the window
        close_position(end - 1, bars.c[end - 1], "end_of_test")
        equity[-1] = cash
    return Result(equity, in_pos, trades, events, start, fees_paid, slip_paid, notional, halted)
