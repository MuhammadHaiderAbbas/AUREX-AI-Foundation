"""Small, dependency-free statistics helpers used by the agents."""

import math


def clip(x: float, lo: float = -1.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, x))


def mean(xs: list[float]) -> float:
    return sum(xs) / len(xs) if xs else 0.0


def stdev(xs: list[float]) -> float:
    if len(xs) < 2:
        return 0.0
    m = mean(xs)
    return math.sqrt(sum((x - m) ** 2 for x in xs) / (len(xs) - 1))


def log_returns(closes: list[float]) -> list[float]:
    return [math.log(b / a) for a, b in zip(closes, closes[1:], strict=False) if a > 0 and b > 0]


def norm_cdf(z: float) -> float:
    return 0.5 * (1 + math.erf(z / math.sqrt(2)))


def atr(highs: list[float], lows: list[float], closes: list[float], period: int = 14) -> float:
    trs = []
    for i in range(1, len(closes)):
        trs.append(max(highs[i] - lows[i], abs(highs[i] - closes[i - 1]),
                       abs(lows[i] - closes[i - 1])))
    if len(trs) < period:
        return 0.0
    value = mean(trs[:period])
    for tr in trs[period:]:  # Wilder smoothing
        value = (value * (period - 1) + tr) / period
    return value


def efficiency_ratio(closes: list[float]) -> float:
    """Kaufman efficiency ratio: net move / path length, in [0, 1]."""
    path = sum(abs(b - a) for a, b in zip(closes, closes[1:], strict=False))
    return abs(closes[-1] - closes[0]) / path if path else 0.0


def ks_statistic(a: list[float], b: list[float]) -> float:
    """Two-sample Kolmogorov-Smirnov D statistic."""
    a, b = sorted(a), sorted(b)
    i = j = 0
    d = 0.0
    while i < len(a) and j < len(b):
        if a[i] <= b[j]:
            i += 1
        else:
            j += 1
        d = max(d, abs(i / len(a) - j / len(b)))
    return d


def ks_critical(n: int, m: int, c_alpha: float = 1.358) -> float:
    """Critical D at alpha = 0.05 (c_alpha = 1.358)."""
    return c_alpha * math.sqrt((n + m) / (n * m))


def percentile_rank(values: list[float], x: float) -> float:
    if not values:
        return 0.5
    return sum(v <= x for v in values) / len(values)
