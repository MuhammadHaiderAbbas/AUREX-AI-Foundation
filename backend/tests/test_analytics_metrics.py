"""Pure analytics maths."""

import math
from datetime import UTC, date, datetime, timedelta

import pytest

from app.analytics import metrics as m


def test_daily_points_take_last_of_day_and_forward_fill():
    t0 = datetime(2026, 1, 1, 9, tzinfo=UTC)
    pts = m.daily_points([(t0, 100.0), (t0 + timedelta(hours=5), 101.0), (t0 + timedelta(days=3), 104.0)])
    assert pts == [(date(2026, 1, 1), 101.0), (date(2026, 1, 2), 101.0), (date(2026, 1, 3), 101.0), (date(2026, 1, 4), 104.0)]
    assert m.daily_points([]) == []


def test_cash_flows_are_not_returns():
    days = [(date(2026, 1, 1), 100.0), (date(2026, 1, 2), 160.0), (date(2026, 1, 3), 99.0)]
    flows = {date(2026, 1, 2): 50.0, date(2026, 1, 3): -60.0}
    r = dict(m.daily_returns(days, flows))
    assert r[date(2026, 1, 2)] == pytest.approx(0.10)        # (160-50)/100 - 1
    assert r[date(2026, 1, 3)] == pytest.approx((99 + 60) / 160 - 1)


def test_performance_ratios_match_definitions():
    rets = [0.01, -0.005] * 15
    p = m.performance(rets)
    mean = sum(rets) / len(rets)
    sd = math.sqrt(sum((x - mean) ** 2 for x in rets) / (len(rets) - 1))
    assert p["periods"] == 30
    assert p["total_return"] == pytest.approx(math.prod(1 + x for x in rets) - 1)
    assert p["sharpe"] == pytest.approx(mean / sd * math.sqrt(365))
    down = math.sqrt(sum(min(x, 0) ** 2 for x in rets) / len(rets))
    assert p["sortino"] == pytest.approx(mean / down * math.sqrt(365))
    assert p["max_drawdown"] == pytest.approx(-0.005) and p["max_drawdown_days"] == 1
    assert p["positive_days"] == 0.5 and p["best_day"] == 0.01 and p["worst_day"] == -0.005
    assert p["calmar"] == pytest.approx(p["cagr"] / 0.005)


def test_short_histories_do_not_report_ratios():
    p = m.performance([0.01] * 5)
    assert p["sharpe"] is None and p["sortino"] is None and p["volatility"] is None and p["cagr"] is None
    assert p["total_return"] == pytest.approx(1.01 ** 5 - 1)
    assert m.performance([])["total_return"] == 0


def test_drawdown_duration():
    p = m.performance([0.1, -0.2, 0.05, 0.05, 0.2] + [0.0] * 20)
    assert p["max_drawdown"] == pytest.approx(-0.2) and p["max_drawdown_days"] == 3


def _t(pnl, source="manual", exit_="manual", hours=2, cost=1000.0):
    t0 = datetime(2026, 1, 1, tzinfo=UTC)
    return m.Trade("X", "STOCK", source, exit_, t0, t0 + timedelta(hours=hours), pnl, 1.0, cost)


def test_trade_stats_and_grouping():
    trades = [_t(30), _t(-10, exit_="stop"), _t(20, source="ai", hours=4), _t(-20, source="ai", exit_="stop")]
    s = m.trade_stats(trades)
    assert s["trades"] == 4 and s["win_rate"] == 0.5 and s["net_pnl"] == 20
    assert s["profit_factor"] == pytest.approx(50 / 30) and s["payoff_ratio"] == pytest.approx(25 / 15)
    assert s["expectancy"] == 5 and s["avg_hold_hours"] == 2.5 and s["return_on_cost"] == pytest.approx(20 / 4000)
    by = {g["key"]: g for g in m.group_stats(trades, "source")}
    assert by["manual"]["net_pnl"] == 20 and by["ai"]["net_pnl"] == 0
    assert m.group_stats(trades, "exit")[0]["key"] == "manual"
    assert m.finite(m.trade_stats([_t(5)])["profit_factor"]) is None   # no losses: reported, not infinite
    assert m.trade_stats([])["win_rate"] is None


def test_calibration_bins_and_scores():
    pairs = [(0.9, True)] * 9 + [(0.9, False)] + [(0.3, True)] * 3 + [(0.3, False)] * 7
    c = m.calibration(pairs)
    assert c["n"] == 20 and [b["hit_rate"] for b in c["bins"]] == [0.3, 0.9]
    assert c["ece"] == pytest.approx(0.0)
    assert c["brier"] == pytest.approx((9 * 0.01 + 0.81 + 3 * 0.49 + 7 * 0.09) / 20)
    assert m.calibration([])["brier"] is None
