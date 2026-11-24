"""Pure performance and evaluation maths. No I/O, no Decimal: analytics are floats.

Conventions
- Returns are time-weighted daily returns on equity, net of virtual cash flows:
  r_t = (E_t - F_t) / E_{t-1} - 1, where F_t is the net deposit (+) / withdrawal (-) on day t.
  Deposits and withdrawals therefore never show up as performance.
- Calendar-day annualisation (365): paper accounts are valued every day, crypto trades 24/7.
- Risk-free rate 0 for Sharpe and Sortino.
- Ratios need at least MIN_PERIODS daily returns; below that they are None, not a misleading number.
"""

import math
from dataclasses import dataclass
from datetime import date, datetime, timedelta

ANNUAL = 365
MIN_PERIODS = 20


def daily_points(points: list[tuple[datetime, float]]) -> list[tuple[date, float]]:
    """Last equity of each UTC day, forward-filled across days without an observation."""
    if not points:
        return []
    by_day: dict[date, float] = {}
    for t, e in sorted(points):
        by_day[t.date()] = e
    days, out = sorted(by_day), []
    d, last = days[0], by_day[days[0]]
    while d <= days[-1]:
        last = by_day.get(d, last)
        out.append((d, last))
        d += timedelta(days=1)
    return out


def daily_returns(days: list[tuple[date, float]], flows: dict[date, float]) -> list[tuple[date, float]]:
    out = []
    for (_, prev), (d, eq) in zip(days, days[1:], strict=False):
        if prev > 0:
            out.append((d, (eq - flows.get(d, 0.0)) / prev - 1))
    return out


def _std(xs: list[float]) -> float:
    if len(xs) < 2:
        return 0.0
    m = sum(xs) / len(xs)
    return math.sqrt(sum((x - m) ** 2 for x in xs) / (len(xs) - 1))


def drawdowns(values: list[float]) -> list[float]:
    """Drawdown from the running peak at each point (0 or negative fractions)."""
    peak, out = -math.inf, []
    for v in values:
        peak = max(peak, v)
        out.append(v / peak - 1 if peak > 0 else 0.0)
    return out


def performance(returns: list[float]) -> dict:
    n = len(returns)
    growth = [1.0]
    for r in returns:
        growth.append(growth[-1] * (1 + r))
    total = growth[-1] - 1
    dd = drawdowns(growth)
    max_dd = min(dd) if dd else 0.0
    # longest stretch (in periods) spent below a previous peak
    longest = cur = 0
    for x in dd:
        cur = cur + 1 if x < 0 else 0
        longest = max(longest, cur)
    enough = n >= MIN_PERIODS
    mean = sum(returns) / n if n else 0.0
    vol = _std(returns)
    downside = math.sqrt(sum(min(r, 0) ** 2 for r in returns) / n) if n else 0.0
    years = n / ANNUAL
    cagr = (growth[-1] ** (1 / years) - 1) if enough and years > 0 and growth[-1] > 0 else None
    return {
        "periods": n,
        "total_return": total,
        "cagr": cagr,
        "volatility": vol * math.sqrt(ANNUAL) if enough else None,
        "sharpe": (mean / vol * math.sqrt(ANNUAL)) if enough and vol > 0 else None,
        "sortino": (mean / downside * math.sqrt(ANNUAL)) if enough and downside > 0 else None,
        "max_drawdown": max_dd,
        "max_drawdown_days": longest,
        "calmar": (cagr / -max_dd) if cagr is not None and max_dd < 0 else None,
        "best_day": max(returns) if returns else None,
        "worst_day": min(returns) if returns else None,
        "positive_days": (sum(r > 0 for r in returns) / n) if n else None,
    }


@dataclass
class Trade:
    symbol: str
    asset_class: str
    source: str          # who opened it: manual | ai | autopilot
    exit: str            # how it closed: manual | stop | target | emergency | ...
    opened_at: datetime
    closed_at: datetime
    pnl: float           # realised, net of fees, account currency
    fees: float
    cost: float          # capital deployed (entry notional)


def trade_stats(trades: list[Trade]) -> dict:
    n = len(trades)
    wins = [t.pnl for t in trades if t.pnl > 0]
    losses = [t.pnl for t in trades if t.pnl <= 0]
    gross_win, gross_loss = sum(wins), -sum(losses)
    avg_win = gross_win / len(wins) if wins else 0.0
    avg_loss = -gross_loss / len(losses) if losses else 0.0
    hold = [(t.closed_at - t.opened_at).total_seconds() / 3600 for t in trades]
    return {
        "trades": n, "wins": len(wins), "losses": len(losses),
        "win_rate": len(wins) / n if n else None,
        "net_pnl": sum(t.pnl for t in trades), "fees": sum(t.fees for t in trades),
        "profit_factor": (gross_win / gross_loss) if gross_loss > 0 else (None if not wins else math.inf),
        "avg_win": avg_win, "avg_loss": avg_loss,
        "payoff_ratio": (avg_win / -avg_loss) if avg_loss < 0 else None,
        "expectancy": sum(t.pnl for t in trades) / n if n else None,
        "best": max((t.pnl for t in trades), default=None), "worst": min((t.pnl for t in trades), default=None),
        "avg_hold_hours": sum(hold) / n if n else None,
        "return_on_cost": (sum(t.pnl for t in trades) / sum(t.cost for t in trades)) if n and sum(t.cost for t in trades) else None,
    }


def group_stats(trades: list[Trade], key: str) -> list[dict]:
    groups: dict[str, list[Trade]] = {}
    for t in trades:
        groups.setdefault(getattr(t, key), []).append(t)
    rows = [{"key": k, **{f: trade_stats(v)[f] for f in ("trades", "win_rate", "net_pnl", "profit_factor", "expectancy")}}
            for k, v in groups.items()]
    return sorted(rows, key=lambda r: r["net_pnl"], reverse=True)


def calibration(pairs: list[tuple[float, bool]], bins: int = 5) -> dict:
    """Reliability of confidence scores: per-bin mean confidence vs observed hit rate, Brier, ECE."""
    if not pairs:
        return {"n": 0, "brier": None, "ece": None, "bins": []}
    out, ece = [], 0.0
    for b in range(bins):
        lo, hi = b / bins, (b + 1) / bins
        sel = [(c, y) for c, y in pairs if lo <= c < hi or (b == bins - 1 and c == 1.0)]
        if not sel:
            continue
        conf = sum(c for c, _ in sel) / len(sel)
        hit = sum(y for _, y in sel) / len(sel)
        ece += len(sel) / len(pairs) * abs(conf - hit)
        out.append({"lo": lo, "hi": hi, "n": len(sel), "confidence": conf, "hit_rate": hit})
    brier = sum((c - (1.0 if y else 0.0)) ** 2 for c, y in pairs) / len(pairs)
    return {"n": len(pairs), "brier": brier, "ece": ece, "bins": out}


def finite(x):
    """JSON-safe: replace inf/nan with None (profit factor with no losses is reported separately)."""
    if isinstance(x, float) and not math.isfinite(x):
        return None
    return x
