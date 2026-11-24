"""AI proposals reach the OMS only through the risk gate; autopilot and emergency stop."""

from decimal import Decimal as D

from app.market import service as market_service
from tests.conftest import API, admin_headers, auth_headers, new_client
from tests.test_ai_api import TrendProvider, funded


async def proposal(client, h, symbol="BTC-USD"):
    run = (await client.post(f"{API}/ai/run", headers=h, json={"symbol": symbol})).json()
    assert run["decision"] == "BUY", run["reasons"]
    return run["proposal"]


async def test_executing_a_proposal_places_a_bracketed_order(client):
    market_service.set_provider("synthetic", TrendProvider())
    h, acct = await funded(client)
    p = await proposal(client, h)
    r = await client.post(f"{API}/ai/proposals/{p['id']}/execute", headers=h)
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["proposal"]["status"] == "EXECUTED" and out["order_status"] == "FILLED", out
    o = (await client.get(f"{API}/trading/orders/{out['order_id']}", headers=h)).json()
    assert o["source"] == "ai" and o["proposal_id"] == p["id"] and D(o["quantity"]) == D(p["quantity"])
    assert {c["type"] for c in o["children"]} == {"STOP", "LIMIT"} and all(c["proposal_id"] == p["id"] for c in o["children"])
    assert o["risk_checks"] and all(c["passed"] for c in o["risk_checks"])
    # a proposal executes at most once
    assert (await client.post(f"{API}/ai/proposals/{p['id']}/execute", headers=h)).status_code == 422
    ah = await admin_headers(client)
    assert (await client.get(f"{API}/admin/audit?action=ai.proposal.execute", headers=ah)).json()["total"] == 1
    async with new_client() as other:
        oh = await auth_headers(other, email="other@example.com")
        assert (await other.post(f"{API}/ai/proposals/{p['id']}/execute", headers=oh)).status_code == 404


async def test_risk_gate_can_refuse_a_proposal(client):
    market_service.set_provider("synthetic", TrendProvider())
    h, acct = await funded(client)
    p = await proposal(client, h)
    await client.put(f"{API}/risk/accounts/{acct['id']}/limits", headers=h, json={"max_position_pct": 1})
    out = (await client.post(f"{API}/ai/proposals/{p['id']}/execute", headers=h)).json()
    assert out["proposal"]["status"] == "RISK_REJECTED" and out["order_status"] == "REJECTED"
    assert out["reason"].startswith("risk: position would be") and out["proposal"]["decision_reason"] == out["reason"]
    dec = (await client.get(f"{API}/risk/decisions?account_id={acct['id']}", headers=h)).json()["items"][0]
    assert dec["source"] == "ai" and dec["proposal_id"] == p["id"] and dec["approved"] is False
    bal = (await client.get(f"{API}/accounts/{acct['id']}", headers=h)).json()
    assert D(bal["cash_balance"]) == 100000


async def test_autopilot_cycle_and_controls(client):
    market_service.set_provider("synthetic", TrendProvider())
    h, acct = await funded(client)
    aid = acct["id"]
    assert (await client.post(f"{API}/risk/accounts/{aid}/autopilot/run", headers=h)).status_code == 422  # not running
    assert (await client.post(f"{API}/risk/accounts/{aid}/autopilot", headers=h,
                              json={"action": "start", "symbols": ["NOPE"]})).status_code == 404
    r = await client.post(f"{API}/risk/accounts/{aid}/autopilot", headers=h, json={"action": "start", "symbols": ["BTC-USD", "ETH-USD"]})
    assert r.json()["autopilot"] == {**r.json()["autopilot"], "status": "RUNNING", "symbols": ["BTC-USD", "ETH-USD"]}
    out = (await client.post(f"{API}/risk/accounts/{aid}/autopilot/run", headers=h)).json()
    assert [x["symbol"] for x in out["results"]] == ["BTC-USD", "ETH-USD"]
    assert {x["outcome"] for x in out["results"]} <= {"executed", "risk_rejected", "no_trade"}
    assert any(x["outcome"] == "executed" for x in out["results"]), out
    orders = (await client.get(f"{API}/trading/orders?account_id={aid}", headers=h)).json()["items"]
    assert {o["source"] for o in orders} == {"autopilot", "protective"}
    # second cycle skips instruments it already holds
    out2 = (await client.post(f"{API}/risk/accounts/{aid}/autopilot/run", headers=h)).json()
    assert all(x["outcome"] in ("skipped", "no_trade", "executed", "risk_rejected") for x in out2["results"])
    assert any(x["outcome"] == "skipped" for x in out2["results"])

    # the kill switch pauses the autopilot; it cannot restart while blocked
    await client.post(f"{API}/risk/accounts/{aid}/kill-switch", headers=h, json={"engaged": True})
    ov = (await client.get(f"{API}/risk/accounts/{aid}", headers=h)).json()
    assert ov["autopilot"]["status"] == "PAUSED"
    r = await client.post(f"{API}/risk/accounts/{aid}/autopilot", headers=h, json={"action": "start"})
    assert r.status_code == 422 and "kill switch" in r.json()["error"]["message"]
    events = [e["type"] for e in (await client.get(f"{API}/risk/events?account_id={aid}", headers=h)).json()["items"]]
    assert "AUTOPILOT_START" in events and "AUTOPILOT_CYCLE" in events


async def test_emergency_stop_flattens_everything(client):
    market_service.set_provider("synthetic", TrendProvider())
    h, acct = await funded(client)
    aid = acct["id"]
    await client.post(f"{API}/risk/accounts/{aid}/autopilot", headers=h, json={"action": "start", "symbols": ["BTC-USD"]})
    out = (await client.post(f"{API}/risk/accounts/{aid}/autopilot/run", headers=h)).json()
    assert out["results"][0]["outcome"] == "executed", out
    r = await client.post(f"{API}/risk/accounts/{aid}/emergency-stop", headers=h, json={"flatten": True})
    assert r.status_code == 200, r.text
    ov = r.json()
    assert ov["autopilot"]["status"] == "STOPPED" and ov["state"]["kill_switch"] is True
    assert ov["metrics"]["open_positions"] == 0
    opened = (await client.get(f"{API}/trading/orders?account_id={aid}&status=OPEN", headers=h)).json()
    assert opened["total"] == 0
    sells = [o for o in (await client.get(f"{API}/trading/orders?account_id={aid}", headers=h)).json()["items"] if o["source"] == "emergency"]
    assert len(sells) == 1 and sells[0]["status"] == "FILLED"
    bal = (await client.get(f"{API}/accounts/{aid}/balances", headers=h)).json()
    assert bal["ledger_balanced"] is True
    ev = (await client.get(f"{API}/risk/events?account_id={aid}", headers=h)).json()["items"][0]
    assert ev["type"] == "EMERGENCY_STOP"


async def test_emergency_stop_without_flatten_keeps_protective_stops(client):
    market_service.set_provider("synthetic", TrendProvider())
    h, acct = await funded(client)
    p = await proposal(client, h)
    await client.post(f"{API}/ai/proposals/{p['id']}/execute", headers=h)
    ov = (await client.post(f"{API}/risk/accounts/{acct['id']}/emergency-stop", headers=h, json={})).json()
    assert ov["metrics"]["open_positions"] == 1
    opened = (await client.get(f"{API}/trading/orders?account_id={acct['id']}&status=OPEN", headers=h)).json()["items"]
    assert {o["source"] for o in opened} == {"protective"}
