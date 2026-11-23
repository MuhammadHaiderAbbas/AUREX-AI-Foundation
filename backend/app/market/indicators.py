"""Technical indicators on close prices.

Analytics only: floats are acceptable here (unlike the ledger). Outputs are aligned
with the input series; warm-up positions are None.
"""

import math

Series = list[float | None]


def sma(values: list[float], period: int) -> Series:
    out: Series = [None] * len(values)
    window = 0.0
    for i, v in enumerate(values):
        window += v
        if i >= period:
            window -= values[i - period]
        if i >= period - 1:
            out[i] = window / period
    return out


def ema(values: list[float], period: int) -> Series:
    out: Series = [None] * len(values)
    if len(values) < period:
        return out
    k = 2 / (period + 1)
    prev = sum(values[:period]) / period
    out[period - 1] = prev
    for i in range(period, len(values)):
        prev = values[i] * k + prev * (1 - k)
        out[i] = prev
    return out


def rsi(values: list[float], period: int = 14) -> Series:
    """Wilder's RSI."""
    out: Series = [None] * len(values)
    if len(values) <= period:
        return out
    gains = losses = 0.0
    for i in range(1, period + 1):
        d = values[i] - values[i - 1]
        gains += max(d, 0)
        losses += max(-d, 0)
    avg_g, avg_l = gains / period, losses / period

    def _r(g: float, loss: float) -> float:
        return 100.0 if loss == 0 else 100 - 100 / (1 + g / loss)

    out[period] = _r(avg_g, avg_l)
    for i in range(period + 1, len(values)):
        d = values[i] - values[i - 1]
        avg_g = (avg_g * (period - 1) + max(d, 0)) / period
        avg_l = (avg_l * (period - 1) + max(-d, 0)) / period
        out[i] = _r(avg_g, avg_l)
    return out


def bollinger(values: list[float], period: int = 20, k: float = 2.0) -> dict[str, Series]:
    mid = sma(values, period)
    upper: Series = [None] * len(values)
    lower: Series = [None] * len(values)
    for i in range(period - 1, len(values)):
        window = values[i - period + 1 : i + 1]
        m = mid[i]
        assert m is not None
        sd = math.sqrt(sum((v - m) ** 2 for v in window) / period)
        upper[i], lower[i] = m + k * sd, m - k * sd
    return {"middle": mid, "upper": upper, "lower": lower}


def macd(values: list[float], fast: int = 12, slow: int = 26, signal: int = 9) -> dict[str, Series]:
    f, s = ema(values, fast), ema(values, slow)
    line = _diff(f, s)
    start = next((i for i, v in enumerate(line) if v is not None), len(values))
    sig_tail = ema([v for v in line[start:] if v is not None], signal)
    sig: Series = [None] * start + sig_tail
    return {"macd": line, "signal": sig, "histogram": _diff(line, sig)}


def _diff(a: Series, b: Series) -> Series:
    return [x - y if x is not None and y is not None else None for x, y in zip(a, b, strict=True)]


SUPPORTED = {"sma20", "sma50", "ema20", "ema50", "rsi14", "bb20", "macd"}


def compute(names: set[str], closes: list[float]) -> dict[str, Series | dict[str, Series]]:
    out: dict[str, Series | dict[str, Series]] = {}
    for name in sorted(names & SUPPORTED):
        if name.startswith("sma"):
            out[name] = sma(closes, int(name[3:]))
        elif name.startswith("ema"):
            out[name] = ema(closes, int(name[3:]))
        elif name == "rsi14":
            out[name] = rsi(closes, 14)
        elif name == "bb20":
            out[name] = bollinger(closes, 20)
        elif name == "macd":
            out[name] = macd(closes)
    return out
