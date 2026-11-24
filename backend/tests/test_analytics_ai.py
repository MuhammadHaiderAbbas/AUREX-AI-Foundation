"""AI attribution: an executed proposal's round trip is credited to the AI and calibrated."""

from app.market import service as market_service
from tests.conftest import API
from tests.test_ai_api import TrendProvider, funded


async def test_executed_proposal_outcome_is_attributed_to_ai(client):
    market_service.set_provider("synthetic", TrendProvider())
    h, acct = await funded(client)
    aid = acct["id"]
    run = (await client.post(f"{API}/ai/run", headers=h, json={"symbol": "BTC-USD"})).json()
    p = run["proposal"]
    out = (await client.post(f"{API}/ai/proposals/{p['id']}/execute", headers=h)).json()
    assert out["order_status"] == "FILLED"
    order = (await client.get(f"{API}/trading/orders/{out['order_id']}", headers=h)).json()
    r = await client.post(f"{API}/trading/orders", headers=h, json={
        "account_id": aid, "symbol": "BTC-USD", "side": "SELL", "type": "MARKET", "quantity": order["quantity"]})
    assert r.json()["status"] == "FILLED"

    t = (await client.get(f"{API}/analytics/accounts/{aid}/trades", headers=h)).json()
    assert t["stats"]["trades"] == 1 and t["by_source"][0]["key"] == "ai" and t["trades"][0]["exit"] == "manual"
    a = (await client.get(f"{API}/analytics/accounts/{aid}/ai", headers=h)).json()
    assert a["proposals"]["by_status"] == {"EXECUTED": 1} and a["proposals"]["execution_rate"] == 1
    assert a["realised"]["closed_trades"] == 1 and a["realised"]["calibration"]["n"] == 1
    assert a["signals"]["pending"] == 1     # the run is younger than the 24h horizon
