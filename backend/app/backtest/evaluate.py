"""Metrics and the in-sample → out-of-sample protocol.

Protocol: the period is split 60/40 by time. With `optimise`, every combination in the
strategy's grid runs on the in-sample segment only and the best in-sample Sharpe (with at
least 3 trades) is selected. The chosen parameters then run ONCE on the untouched
out-of-sample segment. Degradation between the two is reported, and large decay is
flagged as overfitting risk.
"""

import math
from datetime import datetime
from typing import Any

import numpy as np

from app.backtest import strategies as strat
from app.backtest.engine import Bars, Costs, Result, Risk, run
from app.ml.validation import BARS_PER_YEAR

IS_FRACTION = 0.6
# The benchmark is fully invested with no stops or circuit breakers (classic buy & hold).
BENCHMARK_RISK = Risk(risk_per_trade=1e9, max_position_pct=0.998, stop_atr=1e9, target_atr=1e9,
                      daily_loss_limit=1.0, max_drawdown=1.0)


class BuyAndHold:
    key, warmup = "buy_and_hold", 1

    def prepare(self, b: Bars) -> None: ...

    def signal(self, i: int, in_position: bool) -> str | None:
        return None if in_position else "enter"


def metrics(r: Result, asset_class: str, capital: float) -> dict[str, Any]:
    eq = r.equity
    rets = np.diff(eq) / eq[:-1]
    ppy = BARS_PER_YEAR[asset_class]
    n = len(eq)
    total = eq[-1] / capital - 1
    years = n / ppy
    cagr = (eq[-1] / capital) ** (1 / years) - 1 if years > 0 and eq[-1] > 0 else 0.0
    sd = rets.std(ddof=1) if len(rets) > 1 else 0.0
    down = rets[rets < 0]
    dsd = math.sqrt((down ** 2).mean()) if len(down) else 0.0
    peak = np.maximum.accumulate(np.concatenate([[capital], eq]))[1:]
    dd = 1 - eq / peak
    mdd = float(dd.max())
    pnls = [t.pnl for t in r.trades]
    wins, losses = [p for p in pnls if p > 0], [p for p in pnls if p <= 0]
    held = [t.exit_index - t.entry_index + 1 for t in r.trades if t.exit_index is not None]
    return {
        "total_return": round(float(total), 5), "cagr": round(float(cagr), 5),
        "volatility": round(float(sd * math.sqrt(ppy)), 5),
        "sharpe": round(float(rets.mean() / sd * math.sqrt(ppy)), 3) if sd > 0 else 0.0,
        "sortino": round(float(rets.mean() / dsd * math.sqrt(ppy)), 3) if dsd > 0 else 0.0,
        "max_drawdown": round(mdd, 5), "calmar": round(float(cagr / mdd), 3) if mdd > 0 else 0.0,
        "trades": len(r.trades), "win_rate": round(len(wins) / len(pnls), 4) if pnls else 0.0,
        "profit_factor": round(sum(wins) / -sum(losses), 3) if losses and sum(losses) < 0 else None,
        "avg_win": round(float(np.mean(wins)), 2) if wins else 0.0,
        "avg_loss": round(float(np.mean(losses)), 2) if losses else 0.0,
        "avg_bars_held": round(float(np.mean(held)), 1) if held else 0.0,
        "exposure": round(float(r.in_position.mean()), 4),
        "turnover": round(r.traded_notional / float(np.mean(eq)), 2),
        "fees": round(r.fees, 2), "slippage_and_spread": round(r.slippage, 2),
        "halted": r.halted, "risk_events": len(r.events), "bars": n,
    }


def _trade_rows(r: Result, limit: int = 300) -> list[dict[str, Any]]:
    return [{"entry_time": t.entry_time.isoformat(), "exit_time": t.exit_time.isoformat() if t.exit_time else None,
             "entry_price": t.entry_price, "exit_price": t.exit_price, "qty": t.qty, "pnl": round(t.pnl, 2),
             "return": round((t.exit_price / t.entry_price - 1), 5) if t.exit_price else None,
             "fees": round(t.entry_fee + t.exit_fee, 2), "exit_reason": t.exit_reason,
             "bars_held": (t.exit_index - t.entry_index + 1) if t.exit_index is not None else None}
            for t in r.trades[-limit:]]


def _curve(r: Result, t: list[datetime], n: int = 400) -> list[list]:
    idx = np.linspace(0, len(r.equity) - 1, min(n, len(r.equity))).astype(int)
    return [[t[r.start_index + i].isoformat(), round(float(r.equity[i]), 2)] for i in idx]


def evaluate(bars: Bars, key: str, params: dict[str, Any] | None, *, asset_class: str, costs: Costs,
             risk: Risk, capital: float, optimise: bool, lot_size: float) -> dict[str, Any]:
    n = len(bars)
    split = int(n * IS_FRACTION)
    spec = strat.STRATEGIES[key]

    def go(p: dict[str, Any] | None, start: int | None, end: int | None, s=None) -> Result:
        strategy = s or strat.build(key, p)[0]
        return run(bars, strategy, costs, risk, capital=capital, start=start, end=end, lot_size=lot_size)

    grid_rows: list[dict[str, Any]] = []
    chosen = strat.build(key, params)[1]
    if optimise:
        best = None
        for combo in spec.grid:
            try:
                r = go(combo, None, split)
            except ValueError:
                continue
            m = metrics(r, asset_class, capital)
            grid_rows.append({"params": combo, "sharpe": m["sharpe"], "total_return": m["total_return"],
                              "max_drawdown": m["max_drawdown"], "trades": m["trades"]})
            if m["trades"] >= 3 and (best is None or m["sharpe"] > best[0]):
                best = (m["sharpe"], combo)
        if best:
            chosen = strat.build(key, best[1])[1]

    r_is, r_oos = go(chosen, None, split), go(chosen, split, None)
    r_full = go(chosen, None, None)
    bh = BENCHMARK_RISK
    bh_is = run(bars, BuyAndHold(), costs, bh, capital=capital, end=split, lot_size=lot_size)
    bh_oos = run(bars, BuyAndHold(), costs, bh, capital=capital, start=split, lot_size=lot_size)
    bh_full = run(bars, BuyAndHold(), costs, bh, capital=capital, start=r_full.start_index, lot_size=lot_size)
    m_is, m_oos = metrics(r_is, asset_class, capital), metrics(r_oos, asset_class, capital)
    b_is, b_oos = metrics(bh_is, asset_class, capital), metrics(bh_oos, asset_class, capital)

    warnings: list[str] = []
    if m_is["sharpe"] > 0.5 and m_oos["sharpe"] < 0.5 * m_is["sharpe"]:
        warnings.append(f"Overfitting risk: out-of-sample Sharpe {m_oos['sharpe']:.2f} is far below in-sample {m_is['sharpe']:.2f}")
    if m_oos["total_return"] < b_oos["total_return"]:
        warnings.append("Out-of-sample the strategy underperformed buy & hold after costs")
    if m_oos["trades"] < 10:
        warnings.append(f"Only {m_oos['trades']} out-of-sample trades: results are statistically fragile")
    if r_oos.halted:
        warnings.append("The 10% drawdown circuit breaker halted the strategy out-of-sample")

    return {
        "params": chosen, "optimised": optimise, "split_time": bars.t[split].isoformat(),
        "in_sample": {"strategy": m_is, "buy_hold": b_is}, "out_of_sample": {"strategy": m_oos, "buy_hold": b_oos},
        "full": metrics(r_full, asset_class, capital),
        "degradation": {"sharpe": round(m_oos["sharpe"] - m_is["sharpe"], 3),
                        "total_return": round(m_oos["total_return"] - m_is["total_return"], 5)},
        "grid": grid_rows, "warnings": warnings,
        "curves": {"strategy": _curve(r_full, bars.t), "buy_hold": _curve(bh_full, bars.t)},
        "trades": _trade_rows(r_full), "events": r_full.events,
    }
