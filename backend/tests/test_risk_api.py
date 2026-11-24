"""Phase 9: the risk gate on real orders, breakers, kill switches, brackets, system halt."""

from decimal import Decimal as D

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import DBAPIError

from app.database.session import SessionLocal
from app.models import RiskDecision
from tests.conftest import API, admin_headers, auth_headers, new_client
from tests.test_trading import PRICES, fake_quotes, ledger, order, set_price, setup  # noqa: F401 (fixture)


async def risk(client, h, aid):
    r = await client.get(f"{API}/risk/accounts/{aid}", headers=h)
    assert r.status_code == 200, r.text
    return r.json()


async def process(client):
    ah = await admin_headers(client)
    return (await client.post(f"{API}/trading/process", headers=ah)).json()


async def test_overview_defaults_and_privacy(client):
    h, aid = await setup(client)
    r = await risk(client, h, aid)
    assert r["limits"] == {"risk_per_trade_pct": 0.5, "max_position_pct": 20.0, "max_gross_exposure_pct": 50.0,
                           "max_open_positions": 5, "daily_loss_limit_pct": 2.0, "max_drawdown_pct": 10.0,
                           "max_orders_per_minute": 20, "price_collar_pct": 5.0}
    assert r["state"]["blocked_reason"] is None and r["autopilot"]["status"] == "STOPPED"
    assert D(r["metrics"]["equity"]) == 100000 and r["metrics"]["drawdown_pct"] == 0
    async with new_client() as other:
        oh = await auth_headers(other, email="other@example.com")
        assert (await other.get(f"{API}/risk/accounts/{aid}", headers=oh)).status_code == 404
        assert (await other.post(f"{API}/risk/accounts/{aid}/kill-switch", headers=oh, json={"engaged": True})).status_code == 404
        assert (await other.get(f"{API}/risk/decisions?account_id={aid}", headers=oh)).status_code == 404


async def test_sizing_limits_reject_and_every_decision_is_logged(client):
    h, aid = await setup(client)
    o = (await order(client, h, aid, qty="110", stop_loss="199.00")).json()   # 22k of AAPL = 22% of equity
    assert o["status"] == "REJECTED" and o["reject_reason"].startswith("risk: position would be 22.0% of equity")
    assert any(c["name"] == "position_size" and not c["passed"] for c in o["risk_checks"])
    assert o["events"][-2]["type"] == "RISK_REJECTED"
    o = (await order(client, h, aid, qty="50", stop_loss="180.00")).json()  # risks 1% to its stop
    assert o["status"] == "REJECTED" and "risk: trade risks 1.00% of equity" in o["reject_reason"]
    o = (await order(client, h, aid, symbol="BTC-USD", qty="0.3")).json()   # 15k, default 5% stop → 0.75%
    assert "risk: trade risks 0.75%" in o["reject_reason"]
    ok = (await order(client, h, aid, qty="50", stop_loss="195.00")).json()
    assert ok["status"] == "FILLED" and all(c["passed"] for c in ok["risk_checks"])

    dec = (await client.get(f"{API}/risk/decisions?account_id={aid}", headers=h)).json()
    assert dec["total"] == 4 and [d["approved"] for d in dec["items"]] == [True, False, False, False]
    rej = (await client.get(f"{API}/risk/decisions?account_id={aid}&approved=false", headers=h)).json()
    assert rej["total"] == 3
    async with SessionLocal() as db:   # decisions are append-only evidence
        d = await db.scalar(select(RiskDecision))
        with pytest.raises(DBAPIError):
            await db.execute(text("UPDATE risk_decisions SET approved = true WHERE id = :i"), {"i": d.id})
            await db.commit()


async def test_gross_exposure_and_collar(client):
    h, aid = await setup(client)
    r = await client.put(f"{API}/risk/accounts/{aid}/limits", headers=h, json={"max_gross_exposure_pct": 5})
    assert r.status_code == 200 and r.json()["limits"]["max_gross_exposure_pct"] == 5
    assert (await order(client, h, aid, qty="15")).json()["status"] == "FILLED"           # 3%
    # a resting buy counts toward exposure too
    assert (await order(client, h, aid, symbol="MSFT", type="LIMIT", limit_price="399.00", qty="3")).json()["status"] == "OPEN"
    r = (await order(client, h, aid, symbol="NVDA", qty="10")).json()
    assert "risk: gross exposure would be 5.2% of equity" in r["reject_reason"], r["reject_reason"]
    r = (await order(client, h, aid, type="LIMIT", limit_price="215.00", qty="1")).json()  # 7.5% above the ask
    assert "price collar" not in r["reject_reason"] and "through the market" in r["reject_reason"]
    r = (await order(client, h, aid, side="SELL", type="LIMIT", limit_price="180.00", qty="1")).json()
    assert r["status"] == "REJECTED" and "through the market" in r["reject_reason"]
    assert (await order(client, h, aid, side="SELL", qty="15")).json()["status"] == "FILLED"   # reducing: fine


async def test_limit_changes_are_bounded_and_audited(client):
    h, aid = await setup(client)
    assert (await client.put(f"{API}/risk/accounts/{aid}/limits", headers=h, json={"risk_per_trade_pct": 3})).status_code == 422
    assert (await client.put(f"{API}/risk/accounts/{aid}/limits", headers=h, json={"max_open_positions": 0})).status_code == 422
    r = await client.put(f"{API}/risk/accounts/{aid}/limits", headers=h, json={"risk_per_trade_pct": 1.0, "max_drawdown_pct": 5})
    assert r.json()["limits"]["risk_per_trade_pct"] == 1.0 and r.json()["limits"]["max_drawdown_pct"] == 5
    ev = (await client.get(f"{API}/risk/events?account_id={aid}", headers=h)).json()["items"][0]
    assert ev["type"] == "LIMITS_CHANGED" and "loosened: risk_per_trade_pct" in ev["message"]
    ah = await admin_headers(client)
    assert (await client.get(f"{API}/admin/audit?action=risk.limits.update", headers=ah)).json()["total"] == 1


async def test_bracket_orders_are_one_cancels_other(client):
    h, aid = await setup(client)
    o = (await order(client, h, aid, qty="10", stop_loss="190.00", take_profit="220.00")).json()
    assert o["status"] == "FILLED" and len(o["children"]) == 2
    kids = {c["type"]: c for c in o["children"]}
    assert kids["STOP"]["stop_price"] and D(kids["STOP"]["stop_price"]) == 190 and D(kids["LIMIT"]["limit_price"]) == 220
    assert all(c["source"] == "protective" and c["status"] == "OPEN" and c["oco_group"] for c in o["children"])
    assert "BRACKET_PLACED" in [e["type"] for e in o["events"]]
    set_price("AAPL", "225")
    assert (await process(client))["filled"] == 1
    tp = (await client.get(f"{API}/trading/orders/{kids['LIMIT']['id']}", headers=h)).json()
    sl = (await client.get(f"{API}/trading/orders/{kids['STOP']['id']}", headers=h)).json()
    assert tp["status"] == "FILLED" and sl["status"] == "CANCELLED" and sl["events"][-1]["type"] == "OCO_CANCELLED"
    s = (await client.get(f"{API}/portfolio/summary?account_id={aid}", headers=h)).json()
    assert s["open_positions"] == 0 and D(s["realised_pnl"]) > 0
    await ledger(client, h, aid)


async def test_manual_sells_resize_then_cancel_protective_orders(client):
    h, aid = await setup(client)
    o = (await order(client, h, aid, qty="10", stop_loss="190.00")).json()
    stop = o["children"][0]
    assert (await order(client, h, aid, side="SELL", qty="4")).json()["status"] == "FILLED"   # protective qty not "pending"
    s = (await client.get(f"{API}/trading/orders/{stop['id']}", headers=h)).json()
    assert s["status"] == "OPEN" and D(s["quantity"]) == 6 and s["events"][-1]["type"] == "RESIZED"
    assert (await order(client, h, aid, side="SELL", qty="6")).json()["status"] == "FILLED"
    s = (await client.get(f"{API}/trading/orders/{stop['id']}", headers=h)).json()
    assert s["status"] == "CANCELLED" and s["reject_reason"] == "position closed"
    # validation of bracket prices
    assert (await order(client, h, aid, side="SELL", qty="1", stop_loss="190.00")).status_code == 422
    assert (await order(client, h, aid, qty="1", stop_loss="210.00", take_profit="205.00")).status_code == 422
    r = (await order(client, h, aid, qty="1", stop_loss="201.00")).json()
    assert r["status"] == "REJECTED" and "must be below the entry price" in r["reject_reason"]


async def test_protective_stop_fires_on_a_drop(client):
    h, aid = await setup(client)
    o = (await order(client, h, aid, qty="10", stop_loss="190.00", take_profit="230.00")).json()
    set_price("AAPL", "185")
    await process(client)
    exes = (await client.get(f"{API}/trading/executions?account_id={aid}", headers=h)).json()
    assert exes["total"] == 2 and D(exes["items"][0]["realised_pnl"]) < 0
    tp = next(c for c in (await client.get(f"{API}/trading/orders/{o['id']}", headers=h)).json()["children"] if c["type"] == "LIMIT")
    assert tp["status"] == "CANCELLED"


async def test_kill_switch_blocks_new_exposure_but_allows_exits(client):
    h, aid = await setup(client)
    assert (await order(client, h, aid, qty="10")).json()["status"] == "FILLED"
    resting = (await order(client, h, aid, symbol="MSFT", type="LIMIT", limit_price="390.00", qty="1")).json()
    r = await client.post(f"{API}/risk/accounts/{aid}/kill-switch", headers=h, json={"engaged": True, "reason": "stepping away"})
    assert r.status_code == 200 and r.json()["state"]["kill_switch"] is True
    assert r.json()["state"]["blocked_reason"] == "account kill switch is engaged: stepping away"
    got = (await client.get(f"{API}/trading/orders/{resting['id']}", headers=h)).json()
    assert got["status"] == "CANCELLED" and "kill switch" in got["reject_reason"]
    r = (await order(client, h, aid, symbol="NVDA", qty="1")).json()
    assert r["status"] == "REJECTED" and "kill switch is engaged" in r["reject_reason"]
    assert (await order(client, h, aid, side="SELL", qty="10")).json()["status"] == "FILLED"
    assert (await client.post(f"{API}/risk/accounts/{aid}/kill-switch", headers=h, json={"engaged": True})).status_code == 422
    r = await client.post(f"{API}/risk/accounts/{aid}/kill-switch", headers=h, json={"engaged": False})
    assert r.json()["state"]["kill_switch"] is False
    assert (await order(client, h, aid, symbol="NVDA", qty="1")).json()["status"] == "FILLED"
    types = [e["type"] for e in (await client.get(f"{API}/risk/events?account_id={aid}", headers=h)).json()["items"]]
    assert types[:2] == ["KILL_SWITCH_OFF", "KILL_SWITCH_ON"]
    ah = await admin_headers(client)
    assert (await client.get(f"{API}/admin/audit?action=risk.kill_switch.engage", headers=ah)).json()["total"] == 1


async def test_abnormal_order_rate_engages_kill_switch(client):
    h, aid = await setup(client)
    await client.put(f"{API}/risk/accounts/{aid}/limits", headers=h, json={"max_orders_per_minute": 3})
    for _ in range(3):
        assert (await order(client, h, aid, qty="1")).json()["status"] == "FILLED"
    r = (await order(client, h, aid, qty="1")).json()
    assert r["status"] == "REJECTED" and "abnormal activity: 4 orders in 60 seconds" in r["reject_reason"]
    ov = await risk(client, h, aid)
    assert ov["state"]["kill_switch"] is True and "abnormal activity" in ov["state"]["kill_reason"]
    ev = (await client.get(f"{API}/risk/events?account_id={aid}", headers=h)).json()["items"]
    assert ev[0]["type"] == "ABNORMAL_ACTIVITY"


async def test_daily_loss_breaker_trips_and_blocks_buys(client):
    h, aid = await setup(client)
    o = (await order(client, h, aid, symbol="BTC-USD", qty="0.3", stop_loss="48500.00")).json()
    assert o["status"] == "FILLED", o["reject_reason"]
    resting = (await order(client, h, aid, type="LIMIT", limit_price="150.00", qty="1")).json()
    set_price("BTC-USD", "42000")                     # −2.4k ≈ −2.4% of the day's starting equity
    ov = await risk(client, h, aid)
    assert ov["state"]["daily_halted"] is True and ov["metrics"]["daily_loss_pct"] > 2
    assert "daily loss limit of 2% reached" in ov["state"]["blocked_reason"]
    assert (await client.get(f"{API}/trading/orders/{resting['id']}", headers=h)).json()["status"] == "CANCELLED"
    r = (await order(client, h, aid, qty="1")).json()
    assert r["status"] == "REJECTED" and "daily loss limit" in r["reject_reason"]
    ev = (await client.get(f"{API}/risk/events?account_id={aid}", headers=h)).json()["items"][0]
    assert ev["type"] == "BREAKER_DAILY_LOSS" and ev["detail"]["cancelled_orders"] == 1
    assert (await order(client, h, aid, symbol="BTC-USD", side="SELL", qty="0.3")).json()["status"] == "FILLED"


async def test_drawdown_breaker_needs_a_manual_reset(client):
    h, aid = await setup(client)
    await client.put(f"{API}/risk/accounts/{aid}/limits", headers=h, json={"max_drawdown_pct": 1, "daily_loss_limit_pct": 5})
    assert (await order(client, h, aid, symbol="BTC-USD", qty="0.3", stop_loss="48500.00")).json()["status"] == "FILLED"
    assert (await client.post(f"{API}/risk/accounts/{aid}/breakers/drawdown/reset", headers=h)).status_code == 422
    set_price("BTC-USD", "45000")
    ov = await risk(client, h, aid)
    assert ov["state"]["drawdown_halted"] is True and ov["state"]["daily_halted"] is False
    set_price("BTC-USD", "50000")                     # recovering does not clear it
    assert (await risk(client, h, aid))["state"]["drawdown_halted"] is True
    assert "maximum drawdown" in (await order(client, h, aid, qty="1")).json()["reject_reason"]
    r = await client.post(f"{API}/risk/accounts/{aid}/breakers/drawdown/reset", headers=h)
    assert r.status_code == 200 and r.json()["state"]["drawdown_halted"] is False and r.json()["metrics"]["drawdown_pct"] == 0
    assert (await order(client, h, aid, qty="1")).json()["status"] == "FILLED"


async def test_cash_movements_neither_trip_nor_mask_breakers(client):
    h, aid = await setup(client)
    await risk(client, h, aid)
    r = await client.post(f"{API}/accounts/{aid}/withdrawals", headers=h, json={"amount": "5000"})
    assert r.status_code == 201
    ov = await risk(client, h, aid)
    assert ov["state"]["daily_halted"] is False and ov["state"]["drawdown_halted"] is False
    assert D(ov["metrics"]["pnl_equity"]) == 100000 and ov["metrics"]["daily_loss_pct"] == 0
    await client.post(f"{API}/accounts/{aid}/deposits", headers=h, json={"amount": "50000"})
    assert (await risk(client, h, aid))["metrics"]["drawdown_pct"] == 0


async def test_platform_halt_blocks_everyone(client):
    h, aid = await setup(client)
    await order(client, h, aid, qty="5")
    resting = (await order(client, h, aid, type="LIMIT", limit_price="195.00", qty="1")).json()
    assert (await client.post(f"{API}/admin/risk/halt", headers=h, json={"halted": True, "reason": "x"})).status_code == 403
    ah = await admin_headers(client)
    assert (await client.post(f"{API}/admin/risk/halt", headers=ah, json={"halted": True})).status_code == 422
    r = await client.post(f"{API}/admin/risk/halt", headers=ah, json={"halted": True, "reason": "exchange incident"})
    assert r.json()["halted"] is True
    assert (await client.get(f"{API}/risk/status", headers=h)).json()["reason"] == "exchange incident"
    assert (await client.get(f"{API}/trading/orders/{resting['id']}", headers=h)).json()["status"] == "CANCELLED"
    r = (await order(client, h, aid, symbol="MSFT", qty="1")).json()
    assert "platform trading is halted: exchange incident" in r["reject_reason"]
    assert (await order(client, h, aid, side="SELL", qty="5")).json()["status"] == "FILLED"
    ev = (await client.get(f"{API}/risk/events?account_id={aid}", headers=h)).json()["items"]
    assert any(e["type"] == "SYSTEM_HALT" and e["account_id"] is None for e in ev)
    await client.post(f"{API}/admin/risk/halt", headers=ah, json={"halted": False})
    assert (await order(client, h, aid, symbol="MSFT", qty="1")).json()["status"] == "FILLED"
