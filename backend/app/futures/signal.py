"""AI model for futures: LONG, SHORT or NO TRADE on a 4-hour horizon, with a suggested leverage.

Logistic regression on hourly features (app.ml.features), five-fold purged walk-forward.
For every confident out-of-sample call it books the trade's return after costs: taker fee on both
sides, plus half a day of funding at the configured rate. It only suggests a trade when:
  - there are at least 40 such trades;
  - the 95% lower bound of their mean return is above zero (positive after costs, with confidence);
  - most time periods are profitable on their own;
  - today's call is confident.
Leverage is sized from volatility: a 2x ATR move against the position costs at most ~25% of margin
(1x to 5x, never above the platform maximum).
"""

import math
from datetime import datetime
from typing import Any

import numpy as np

from app.futures.service import config
from app.market.service import MarketService
from app.ml.features import WARMUP, build_dataset, latest_features

HORIZON = 4               # hours
BARS = 2000               # about 83 days of hourly bars
MIN_TRADES = 40
FOLDS = 5
CONFIDENCE = 0.55


def compute(times: list[datetime], high: list[float], low: list[float], close: list[float], *, fee: float, funding_8h: float,
            max_leverage: int) -> dict[str, Any]:
    from sklearn.linear_model import LogisticRegression
    from sklearn.pipeline import make_pipeline
    from sklearn.preprocessing import StandardScaler

    cost = 2 * fee + funding_8h * HORIZON / 8
    out: dict[str, Any] = {"trade": False, "direction": None, "p_up": None, "confidence": None, "trades": 0, "hit_rate": None,
                           "mean_return": None, "return_lower": None, "folds": 0, "folds_profitable": 0, "cost_per_trade": cost,
                           "suggested_leverage": None, "stop_distance_pct": None, "horizon_hours": HORIZON}
    if len(close) <= WARMUP + HORIZON + 300:
        return {**out, "reason": f"not enough history ({len(close)} hourly bars)"}
    ds = build_dataset(times, high, low, close, HORIZON)
    n = len(ds.y)
    start, rets, fold_means, hits = int(n * 0.5), [], [], 0
    size = (n - start) // FOLDS
    for k in range(FOLDS):
        s0, e0 = start + k * size, n if k == FOLDS - 1 else start + (k + 1) * size
        tr_end = s0 - HORIZON
        if len(set(ds.y[:tr_end])) < 2:
            continue
        m = make_pipeline(StandardScaler(), LogisticRegression(C=0.5, max_iter=500)).fit(ds.X[:tr_end], ds.y[:tr_end])
        p = m.predict_proba(ds.X[s0:e0])[:, 1]
        fold = []
        for i in range(0, e0 - s0, HORIZON):                  # non-overlapping trades
            if max(p[i], 1 - p[i]) < CONFIDENCE:
                continue
            d = 1 if p[i] >= 0.5 else -1
            r = d * float(ds.fwd[s0 + i]) - cost
            fold.append(r)
            hits += r > 0
        rets += fold
        if len(fold) >= 5:
            fold_means.append(float(np.mean(fold)))
    t = len(rets)
    if t:
        mean, sd = float(np.mean(rets)), float(np.std(rets, ddof=1)) if t > 1 else 0.0
        lower = mean - 1.96 * sd / math.sqrt(t)
        out.update(trades=t, hit_rate=hits / t, mean_return=mean, return_lower=lower, folds=len(fold_means),
                   folds_profitable=sum(x > 0 for x in fold_means))
    m = make_pipeline(StandardScaler(), LogisticRegression(C=0.5, max_iter=500)).fit(ds.X, ds.y)
    row = latest_features(times, high, low, close)
    if row is None:
        return {**out, "reason": "latest bar has incomplete features"}
    p_up = float(m.predict_proba(row.reshape(1, -1))[0, 1])
    conf = max(p_up, 1 - p_up)
    atr = _atr(high, low, close, 14)
    move = float(atr) / close[-1] * math.sqrt(HORIZON)       # typical move over the horizon, as a fraction
    lev = int(max(1, min(5, max_leverage, math.floor(0.25 / max(2 * move, 1e-6)))))
    out.update(p_up=p_up, confidence=conf, direction="LONG" if p_up >= 0.5 else "SHORT", suggested_leverage=lev,
               stop_distance_pct=2 * move * 100)
    need = max(3, math.ceil(0.75 * out["folds"]))
    if t < MIN_TRADES:
        out["reason"] = f"too few confident out-of-sample trades to judge ({t} < {MIN_TRADES})"
    elif out["return_lower"] <= 0:
        out["reason"] = (f"no proven edge after costs: average {out['mean_return'] * 100:+.2f}% per trade over {t} trades, "
                         f"but the 95% range reaches {out['return_lower'] * 100:+.2f}%")
    elif out["folds_profitable"] < need:
        out["reason"] = f"edge not consistent: {out['folds_profitable']} of {out['folds']} periods profitable (need {need})"
    elif conf < CONFIDENCE:
        out["reason"] = f"not confident enough now: {conf:.0%} < {CONFIDENCE:.0%}"
    else:
        out["trade"] = True
        out["reason"] = (f"edge validated: {out['mean_return'] * 100:+.2f}% per trade after costs over {t} out-of-sample trades "
                         f"(95% range from {out['return_lower'] * 100:+.2f}%); now {conf:.0%} {out['direction']}")
    return out


def _atr(high: list[float], low: list[float], close: list[float], n: int) -> float:
    tr = [max(high[i] - low[i], abs(high[i] - close[i - 1]), abs(low[i] - close[i - 1])) for i in range(1, len(close))]
    if not tr:
        return 0.0
    v = float(np.mean(tr[:n]))
    for x in tr[n:]:
        v = (v * (n - 1) + x) / n                              # Wilder smoothing
    return v


async def futures_signal(svc: MarketService, symbol: str) -> dict[str, Any]:
    inst = await svc.get(symbol)
    bars = await svc.candles(inst, "1h", BARS)
    cfg = config()
    sig = compute([b.open_time for b in bars], [float(b.high) for b in bars], [float(b.low) for b in bars], [float(b.close) for b in bars],
                  fee=cfg["taker_fee"], funding_8h=cfg["funding_rate_8h"], max_leverage=cfg["max_leverage"])
    return {**sig, "symbol": inst.symbol, "bars": len(bars), "timeframe": "1h"}
