from datetime import UTC, datetime, timedelta

import numpy as np
import pytest

from app.backtest import evaluate as ev
from app.backtest import strategies as strat
from app.backtest.engine import Bars, Costs, Risk, atr, run

T0 = datetime(2026, 3, 2, tzinfo=UTC)   # a Monday
NOCOST = Costs(fee_bps=0, half_spread_bps=0, slippage_bps=0, vol_slippage=0)


def bars(closes, *, opens=None, highs=None, lows=None, times=None) -> Bars:
    c = np.asarray(closes, float)
    o = np.asarray(opens if opens is not None else np.concatenate([[c[0]], c[:-1]]), float)
    h = np.asarray(highs if highs is not None else np.maximum(o, c) * 1.001, float)
    lo = np.asarray(lows if lows is not None else np.minimum(o, c) * 0.999, float)
    t = times or [T0 + timedelta(hours=i) for i in range(len(c))]
    return Bars(t, o, h, lo, c)


class Script:
    """Emits fixed signals at fixed bar indices."""
    key = "script"

    def __init__(self, signals: dict[int, str], warmup: int = 20):
        self.signals, self.warmup = signals, warmup

    def prepare(self, b): ...

    def signal(self, i, in_position):
        return self.signals.get(i)


FLAT = [100.0] * 60


def test_orders_fill_at_next_open_with_costs():
    c = np.array(FLAT)
    o = c.copy()
    o[31] = 101.0                      # the fill bar opens higher than the signal close
    b = bars(c, opens=o)
    costs = Costs(fee_bps=10, half_spread_bps=1, slippage_bps=2, vol_slippage=0, latency_bars=1)
    r = run(b, Script({30: "enter", 40: "exit"}), costs, Risk(stop_atr=50, target_atr=50))
    t = r.trades[0]
    assert t.entry_index == 31 and t.entry_price == pytest.approx(101.0 * (1 + 0.0001 + 0.0002))
    assert t.entry_fee == pytest.approx(t.entry_price * t.qty * 0.001)
    assert t.exit_index == 41 and t.exit_reason == "signal"
    assert t.exit_price == pytest.approx(100.0 * (1 - 0.0003))
    r2 = run(b, Script({30: "enter"}), Costs(0, 0, 0, 0, latency_bars=3), Risk(stop_atr=50, target_atr=50))
    assert r2.trades[0].entry_index == 33          # latency respected
    # cash reconciles with trade P&L (fees included)
    assert r.equity[-1] == pytest.approx(100_000 + sum(x.pnl for x in r.trades))


def test_position_sizing_respects_risk_and_caps():
    b = bars(FLAT)
    a = atr(b)[30]
    r = run(b, Script({30: "enter"}), NOCOST, Risk(stop_atr=10, max_position_pct=1.0))
    assert r.trades[0].qty == pytest.approx(100_000 * 0.005 / (10 * a), rel=1e-6)  # 0.5% risk at the stop
    tight = run(b, Script({30: "enter"}), NOCOST, Risk(stop_atr=2, max_position_pct=1.0))
    assert 100_000 * 0.005 / (2 * a) * 100 > 100_000                                # risk sizing would need leverage…
    assert tight.trades[0].qty * tight.trades[0].entry_price == pytest.approx(100_000)  # …so cash caps it
    capped = run(b, Script({30: "enter"}), NOCOST, Risk(stop_atr=0.01, max_position_pct=0.2))
    assert capped.trades[0].qty * capped.trades[0].entry_price <= 20_000 * 1.0001        # 20% cap, no leverage


def test_gap_through_stop_fills_at_open_and_stop_beats_target():
    c = np.array(FLAT)
    o, h, lo = c.copy(), c * 1.001, c * 0.999
    o[40], h[40], lo[40], c[40] = 90.0, 90.5, 89.5, 90.0       # gap far below any stop
    b = bars(c, opens=o, highs=h, lows=lo)
    r = run(b, Script({30: "enter"}), NOCOST, Risk(stop_atr=2, target_atr=3))
    t = r.trades[0]
    assert t.exit_reason == "stop" and t.exit_index == 40 and t.exit_price == pytest.approx(90.0)
    h2, lo2 = c * 1.001, c * 0.999
    h2[40], lo2[40] = 130.0, 70.0                                  # both touched in one bar
    r = run(bars(FLAT, highs=h2, lows=lo2), Script({30: "enter"}), NOCOST, Risk())
    assert r.trades[0].exit_reason == "stop"                       # pessimistic assumption
    h3 = np.array(FLAT) * 1.001
    h3[40] = 130.0
    r = run(bars(FLAT, highs=h3), Script({30: "enter"}), NOCOST, Risk(stop_atr=2, target_atr=3))
    t = r.trades[0]
    assert t.exit_reason == "target" and t.exit_price == pytest.approx(t.entry_price + 3 * atr(bars(FLAT, highs=h3))[30])


def test_market_closure_gap_fills_at_next_session_open():
    times = [T0 + timedelta(hours=i) for i in range(40)] + [T0 + timedelta(days=3, hours=i) for i in range(20)]
    c = np.array(FLAT)
    o = c.copy()
    o[40] = 105.0                                                   # Monday open after the weekend
    r = run(bars(c, opens=o, times=times), Script({39: "enter"}), NOCOST, Risk(stop_atr=50, target_atr=50))
    assert r.trades[0].entry_time == times[40] and r.trades[0].entry_price == 105.0


def test_daily_loss_limit_and_drawdown_circuit_breaker():
    c = np.array([100.0] * 30 + [100.0] * 5 + [96.0] * 25)          # -4% while fully invested
    o = np.concatenate([[c[0]], c[:-1]])
    risk = Risk(risk_per_trade=1e9, max_position_pct=1.0, stop_atr=1e9, target_atr=1e9, daily_loss_limit=0.02, max_drawdown=0.5)
    r = run(bars(c, opens=o), Script({25: "enter", 36: "exit", 37: "enter"}), NOCOST, risk)
    assert any(e["type"] == "daily_loss_limit" for e in r.events)
    assert len(r.trades) == 1                                       # re-entry blocked for the rest of the day
    c2 = np.array([100.0] * 30 + [80.0] * 30)
    risk2 = Risk(risk_per_trade=1e9, max_position_pct=1.0, stop_atr=1e9, target_atr=1e9, daily_loss_limit=1.0, max_drawdown=0.10)
    r = run(bars(c2), Script({25: "enter", 45: "enter"}), NOCOST, risk2)
    assert r.halted and any(e["type"] == "max_drawdown_halt" for e in r.events)
    assert len(r.trades) == 1 and r.trades[0].exit_reason == "signal"    # flattened, never re-entered


def test_strategies_are_causal():
    rng = np.random.default_rng(5)
    c = 100 * np.exp(np.cumsum(rng.normal(0, 0.01, 400)))
    b1 = bars(c)
    c2 = c.copy()
    c2[300:] *= 1.4
    b2 = bars(c2, opens=b1.o[:300].tolist() + (b1.o[300:] * 1.4).tolist())
    for key in ("sma_crossover", "rsi_reversion", "donchian_breakout"):
        s1, s2 = strat.build(key)[0], strat.build(key)[0]
        s1.prepare(b1)
        s2.prepare(b2)
        assert [s1.signal(i, False) for i in range(s1.warmup, 299)] == [s2.signal(i, False) for i in range(s2.warmup, 299)]
    with pytest.raises(ValueError):
        strat.build("sma_crossover", {"fast": 60, "slow": 50})
    with pytest.raises(ValueError):
        strat.build("donchian_breakout", {"lookback": 9999})


def test_optimiser_only_sees_in_sample(monkeypatch):
    rng = np.random.default_rng(9)
    b = bars(100 * np.exp(np.cumsum(rng.normal(0.0002, 0.01, 1000))))
    calls = []
    real = ev.run

    def spy(bars_, strategy, costs, risk, **kw):
        calls.append((strategy.key, kw.get("start"), kw.get("end")))
        return real(bars_, strategy, costs, risk, **kw)

    monkeypatch.setattr(ev, "run", spy)
    out = ev.evaluate(b, "donchian_breakout", None, asset_class="CRYPTO", costs=NOCOST, risk=Risk(),
                      capital=100_000, optimise=True, lot_size=1e-8)
    split = int(1000 * ev.IS_FRACTION)
    grid_calls = [c for c in calls if c[0] == "donchian_breakout"][:4]
    assert all(c[1] is None and c[2] == split for c in grid_calls)          # grid search: in-sample only
    assert ("donchian_breakout", split, None) in calls                       # one out-of-sample run
    assert len(out["grid"]) == 4 and out["optimised"] is True
    bh = out["out_of_sample"]["buy_hold"]
    assert bh["exposure"] > 0.95 and bh["trades"] == 1                       # benchmark fully invested
    assert set(out) >= {"in_sample", "out_of_sample", "full", "degradation", "curves", "trades", "warnings"}
