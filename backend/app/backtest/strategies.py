"""Strategy definitions. Each precomputes *causal* signal arrays (value at i uses bars ≤ i)
and exposes a parameter grid for in-sample optimisation."""

from dataclasses import dataclass
from typing import Any

import numpy as np

from app.agents import specialists as sp
from app.agents.base import AgentContext, Bar, InstrumentSnap
from app.backtest.engine import Bars
from app.market import indicators as ind


def _arr(values: list[float | None]) -> np.ndarray:
    return np.array([np.nan if v is None else v for v in values], dtype=float)


class SmaCrossover:
    key = "sma_crossover"

    def __init__(self, fast: int = 20, slow: int = 50):
        if fast >= slow:
            raise ValueError("fast must be shorter than slow")
        self.fast, self.slow, self.warmup = fast, slow, slow + 2

    def prepare(self, b: Bars) -> None:
        c = b.c.tolist()
        self.f, self.s = _arr(ind.sma(c, self.fast)), _arr(ind.sma(c, self.slow))

    def signal(self, i: int, in_position: bool) -> str | None:
        if in_position:
            return "exit" if self.f[i] < self.s[i] else None
        crossed = self.f[i] > self.s[i] and self.f[i - 1] <= self.s[i - 1]
        return "enter" if crossed else None


class RsiReversion:
    key = "rsi_reversion"

    def __init__(self, period: int = 14, entry: float = 30, exit: float = 55):
        self.period, self.entry, self.exit_level, self.warmup = period, entry, exit, period + 2

    def prepare(self, b: Bars) -> None:
        self.r = _arr(ind.rsi(b.c.tolist(), self.period))

    def signal(self, i: int, in_position: bool) -> str | None:
        if in_position:
            return "exit" if self.r[i] > self.exit_level else None
        return "enter" if self.r[i] < self.entry <= self.r[i - 1] else None


class DonchianBreakout:
    key = "donchian_breakout"

    def __init__(self, lookback: int = 48):
        self.lookback, self.warmup = lookback, lookback + 2

    def prepare(self, b: Bars) -> None:
        n, lb, ex = len(b), self.lookback, max(2, self.lookback // 2)
        self.hi = np.full(n, np.nan)
        self.lo = np.full(n, np.nan)
        for i in range(lb, n):
            self.hi[i] = b.h[i - lb:i].max()      # prior bars only: no look-ahead
            self.lo[i] = b.l[i - ex:i].min()
        self.c = b.c

    def signal(self, i: int, in_position: bool) -> str | None:
        if in_position:
            return "exit" if self.c[i] < self.lo[i] else None
        return "enter" if self.c[i] > self.hi[i] else None


class AgentConsensus:
    """The Phase 5 technical + quant agents, replayed on a rolling window (research and
    news agents are excluded: the historical corpus is not point-in-time)."""

    key = "agent_consensus"

    def __init__(self, min_net: float = 0.25, every: int = 4, window: int = 200):
        self.min_net, self.every, self.window, self.warmup = min_net, every, window, window
        self.instrument = InstrumentSnap("BT", "CRYPTO", "CRYPTO_24_7", "USD", 8, 1)

    def prepare(self, b: Bars) -> None:
        self.b, self.cache = b, {}

    def _net(self, i: int) -> float:
        if i in self.cache:
            return self.cache[i]
        lo = i - self.window + 1
        bars = [Bar(self.b.t[k], self.b.o[k], self.b.h[k], self.b.l[k], self.b.c[k]) for k in range(lo, i + 1)]
        ctx = AgentContext(self.instrument, self.b.t[i], bars, [], None, [], [], None, None)
        f = [sp.technical(ctx), sp.quant(ctx)]
        w = [(0.35 * x.confidence, x.score) for x in f if x.status == "ok"]
        tot = sum(a for a, _ in w)
        self.cache[i] = sum(a * s for a, s in w) / tot if tot else 0.0
        return self.cache[i]

    def signal(self, i: int, in_position: bool) -> str | None:
        if i % self.every:
            return None
        net = self._net(i)
        if in_position:
            return "exit" if net < 0 else None
        return "enter" if net >= self.min_net else None


@dataclass(frozen=True)
class StrategySpec:
    key: str
    name: str
    description: str
    cls: Any
    defaults: dict[str, Any]
    grid: list[dict[str, Any]]
    params: dict[str, dict[str, Any]]


STRATEGIES: dict[str, StrategySpec] = {s.key: s for s in [
    StrategySpec("sma_crossover", "SMA crossover", "Enter when the fast SMA crosses above the slow SMA; exit when it falls back below.",
                 SmaCrossover, {"fast": 20, "slow": 50},
                 [{"fast": f, "slow": s} for f in (10, 20, 30) for s in (50, 100)],
                 {"fast": {"type": "int", "min": 2, "max": 100}, "slow": {"type": "int", "min": 5, "max": 300}}),
    StrategySpec("rsi_reversion", "RSI mean reversion", "Buy when RSI drops through the entry level; sell when it recovers above the exit level.",
                 RsiReversion, {"period": 14, "entry": 30, "exit": 55},
                 [{"period": 14, "entry": e, "exit": x} for e in (25, 30, 35) for x in (50, 60)],
                 {"period": {"type": "int", "min": 2, "max": 50}, "entry": {"type": "float", "min": 5, "max": 50},
                  "exit": {"type": "float", "min": 30, "max": 95}}),
    StrategySpec("donchian_breakout", "Donchian breakout", "Buy a close above the prior N-bar high; exit below the prior N/2-bar low.",
                 DonchianBreakout, {"lookback": 48}, [{"lookback": n} for n in (24, 48, 96, 168)],
                 {"lookback": {"type": "int", "min": 5, "max": 500}}),
    StrategySpec("agent_consensus", "Agent consensus (technical + quant)",
                 "Replays the Phase 5 technical and quant agents every 4 bars; enters when their weighted net score clears the threshold.",
                 AgentConsensus, {"min_net": 0.25}, [{"min_net": m} for m in (0.2, 0.3)],
                 {"min_net": {"type": "float", "min": 0.05, "max": 0.9}}),
]}


def build(key: str, params: dict[str, Any] | None = None):
    spec = STRATEGIES[key]
    merged = {**spec.defaults, **(params or {})}
    for k, v in merged.items():
        rule = spec.params.get(k)
        if rule is None:
            raise ValueError(f"Unknown parameter {k}")
        if not (rule["min"] <= v <= rule["max"]):
            raise ValueError(f"{k} must be between {rule['min']} and {rule['max']}")
        if rule["type"] == "int":
            merged[k] = int(v)
    return spec.cls(**merged), merged
