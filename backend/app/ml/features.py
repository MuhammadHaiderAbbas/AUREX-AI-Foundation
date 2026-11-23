"""Leak-free feature engineering on hourly bars.

Every feature at row t uses only bars[0..t]. The target at row t is the sign of the
forward return from t to t+H, so the last H rows have no label. A test perturbs future
bars and asserts past features do not change.
"""

import math
from dataclasses import dataclass
from datetime import datetime

import numpy as np

from app.market import indicators as ind

FEATURES = [
    "ret_1", "ret_4", "ret_24", "vol_24", "vol_72", "vol_ratio", "rsi_14", "macd_atr",
    "trend_atr", "bb_pctb", "er_24", "dist_high_72", "hour_sin", "hour_cos",
]
WARMUP = 80  # bars needed before every feature is defined


@dataclass
class Dataset:
    X: np.ndarray            # (n, len(FEATURES))
    y: np.ndarray            # (n,) 1 if forward return > 0
    fwd: np.ndarray          # (n,) simple forward return over the horizon
    times: list[datetime]
    horizon: int


def _rolling_std(x: np.ndarray, n: int) -> np.ndarray:
    out = np.full(len(x), np.nan)
    for t in range(n - 1, len(x)):
        out[t] = np.std(x[t - n + 1:t + 1], ddof=1)
    return out


def feature_matrix(times: list[datetime], h: np.ndarray, lo: np.ndarray, c: np.ndarray) -> np.ndarray:
    n = len(c)
    logc = np.log(c)
    r1 = np.concatenate([[np.nan], np.diff(logc)])

    def lag_ret(k: int) -> np.ndarray:
        out = np.full(n, np.nan)
        out[k:] = logc[k:] - logc[:-k]
        return out

    vol24, vol72 = _rolling_std(r1, 24), _rolling_std(r1, 72)
    closes = c.tolist()
    rsi = np.array([np.nan if v is None else v for v in ind.rsi(closes, 14)], dtype=float)
    hist = np.array([np.nan if v is None else v for v in ind.macd(closes)["histogram"]], dtype=float)
    sma20 = np.array([np.nan if v is None else v for v in ind.sma(closes, 20)], dtype=float)
    sma50 = np.array([np.nan if v is None else v for v in ind.sma(closes, 50)], dtype=float)
    prev = np.concatenate([[c[0]], c[:-1]])
    tr = np.maximum.reduce([h - lo, np.abs(h - prev), np.abs(lo - prev)])
    atr = np.full(n, np.nan)
    for t in range(14, n):
        atr[t] = tr[t - 13:t + 1].mean()
    sd20 = _rolling_std(c, 20)
    er = np.full(n, np.nan)
    absd = np.abs(np.diff(c, prepend=c[0]))
    for t in range(24, n):
        path = absd[t - 23:t + 1].sum()
        er[t] = abs(c[t] - c[t - 24]) / path if path else 0.0
    hi72 = np.full(n, np.nan)
    for t in range(71, n):
        hi72[t] = h[t - 71:t + 1].max()
    hours = np.array([t.hour + t.minute / 60 for t in times])
    with np.errstate(divide="ignore", invalid="ignore"):
        cols = [
            r1, lag_ret(4), lag_ret(24), vol24, vol72, vol24 / vol72, (rsi - 50) / 50,
            hist / atr, (sma20 - sma50) / atr, (c - (sma20 - 2 * sd20)) / (4 * sd20), er,
            c / hi72 - 1, np.sin(2 * math.pi * hours / 24), np.cos(2 * math.pi * hours / 24),
        ]
    X = np.column_stack(cols)
    X[~np.isfinite(X)] = np.nan
    return X


def build_dataset(times: list[datetime], h: list[float], lo: list[float], c: list[float],
                  horizon: int) -> Dataset:
    H, L, C = (np.asarray(v, dtype=float) for v in (h, lo, c))
    X = feature_matrix(times, H, L, C)
    fwd = np.full(len(C), np.nan)
    fwd[:-horizon] = C[horizon:] / C[:-horizon] - 1
    ok = np.isfinite(X).all(axis=1) & np.isfinite(fwd)
    ok[:WARMUP] = False
    idx = np.where(ok)[0]
    return Dataset(X[idx], (fwd[idx] > 0).astype(int), fwd[idx], [times[i] for i in idx], horizon)


def latest_features(times: list[datetime], h: list[float], lo: list[float], c: list[float]) -> np.ndarray | None:
    X = feature_matrix(times, np.asarray(h, float), np.asarray(lo, float), np.asarray(c, float))
    row = X[-1]
    return row if np.isfinite(row).all() else None
