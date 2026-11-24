"""Pure pre-trade risk rules."""

from dataclasses import replace
from decimal import Decimal as D

from app.risk import engine

LIM = engine.Limits(**engine.DEFAULTS)
BASE = engine.PreTrade(
    side="BUY", reduces=False, system_halt=None, kill_switch=None, daily_halted=False, drawdown_halted=False,
    equity=D(100_000), notional=D(5_000), risk_amount=D(250), position_after=D(5_000), exposure_after=D(5_000),
    open_positions_after=1, collar_through_pct=None, orders_last_minute=0)


def failed(p, lim=LIM):
    return {c.name for c in engine.evaluate(p, lim) if not c.passed}


def test_modest_buy_passes_every_check():
    checks = engine.evaluate(BASE, LIM)
    assert all(c.passed for c in checks) and engine.first_failure(checks) is None
    assert {c.name for c in checks} == {"system_halt", "kill_switch", "daily_loss", "drawdown", "order_rate",
                                        "risk_per_trade", "position_size", "gross_exposure", "open_positions"}


def test_each_limit_rejects_with_an_explanation():
    cases = {
        "risk_per_trade": replace(BASE, risk_amount=D(501)),
        "position_size": replace(BASE, position_after=D(20_001)),
        "gross_exposure": replace(BASE, exposure_after=D(50_001)),
        "open_positions": replace(BASE, open_positions_after=6),
        "order_rate": replace(BASE, orders_last_minute=20),
        "price_collar": replace(BASE, collar_through_pct=5.01),
        "system_halt": replace(BASE, system_halt="maintenance"),
        "kill_switch": replace(BASE, kill_switch="manual"),
        "daily_loss": replace(BASE, daily_halted=True),
        "drawdown": replace(BASE, drawdown_halted=True),
    }
    for name, p in cases.items():
        checks = engine.evaluate(p, LIM)
        assert failed(p) == {name}, name
        assert engine.first_failure(checks)
    assert engine.first_failure(engine.evaluate(cases["position_size"], LIM)) == "position would be 20.0% of equity (limit 20%)"


def test_exactly_at_the_limit_is_allowed():
    assert failed(replace(BASE, risk_amount=D(500), position_after=D(20_000), exposure_after=D(50_000),
                          open_positions_after=5, orders_last_minute=19, collar_through_pct=5.0)) == set()


def test_risk_reducing_orders_pass_halts_but_not_rate_or_collar():
    sell = replace(BASE, side="SELL", reduces=True, system_halt="x", kill_switch="y", daily_halted=True,
                   drawdown_halted=True, risk_amount=D(10**9), position_after=D(10**9), exposure_after=D(10**9),
                   open_positions_after=99)
    assert failed(sell) == set()
    assert {c.name for c in engine.evaluate(sell, LIM)} == {"system_halt", "kill_switch", "daily_loss", "drawdown", "order_rate"}
    assert failed(replace(sell, orders_last_minute=25)) == {"order_rate"}
    assert failed(replace(sell, collar_through_pct=9.0)) == {"price_collar"}


def test_tighter_limits_apply_and_zero_equity_fails_closed():
    tight = replace(LIM, max_position_pct=2.0, risk_per_trade_pct=0.1)
    assert failed(BASE, tight) == {"position_size", "risk_per_trade"}
    assert {"risk_per_trade", "position_size", "gross_exposure"} <= failed(replace(BASE, equity=D(0)))
