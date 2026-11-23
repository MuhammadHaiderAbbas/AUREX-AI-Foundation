import math
from datetime import UTC, datetime, timedelta
from decimal import Decimal

from sqlalchemy import text

from app.database.session import SessionLocal
from app.market import service as market_service
from app.market.providers.synthetic import SyntheticProvider
from app.market.types import TIMEFRAMES, Candle, RawQuote
from tests.conftest import API, admin_headers, auth_headers, new_client


class TrendProvider(SyntheticProvider):
    """Deterministic steady uptrend for every instrument (24/7 sessions ignored)."""

    async def get_candles(self, inst, timeframe, start, end):
        tf = TIMEFRAMES[timeframe]
        t = math.ceil(start.timestamp() / tf) * tf
        out = []
        base = float(inst.base_price)
        while t + tf <= end.timestamp():
            i = t / tf
            drift = 0.0015 if timeframe == "1h" else 0.002
            wob = 0.002 if timeframe == "1h" else 0.004
            p0 = base * math.exp(drift * (i % 10_000)) * (1 + wob * math.sin(i * 1.7))
            p1 = base * math.exp(drift * ((i + 1) % 10_000)) * (1 + wob * math.sin((i + 1) * 1.7))
            q = Decimal(1).scaleb(-inst.price_decimals)
            o, c = Decimal(repr(p0)).quantize(q), Decimal(repr(p1)).quantize(q)
            out.append(Candle(datetime.fromtimestamp(t, UTC), o, max(o, c) * Decimal("1.001"),
                              min(o, c) * Decimal("0.999"), c, Decimal(10)))
            t += tf
        return out

    async def get_quote(self, inst):
        now = datetime.now(UTC)
        candles = await self.get_candles(inst, "1h", now - timedelta(hours=3), now)
        last = candles[-1].close
        return RawQuote(last, last * Decimal("0.9999"), last * Decimal("1.0001"), last * Decimal("0.98"),
                        now, "synthetic")


async def funded(client, email="trader@example.com"):
    h = await auth_headers(client, email=email)
    acct = (await client.post(f"{API}/accounts", headers=h, json={"name": "Paper"})).json()
    return h, acct


async def test_agent_registry(client):
    h = await auth_headers(client)
    agents = (await client.get(f"{API}/ai/agents", headers=h)).json()
    names = [a["name"] for a in agents]
    assert set(names) == {"technical", "quant", "fundamental", "news", "sentiment", "ml", "regime", "portfolio", "risk"}
    assert sum(a["weight"] for a in agents if a["kind"] == "directional") == 1.0


async def test_run_returns_explained_decision(client):
    h, acct = await funded(client)
    r = await client.post(f"{API}/ai/run", headers=h, json={"symbol": "BTC-USD"})
    assert r.status_code == 201, r.text
    run = r.json()
    assert [f["agent"] for f in run["findings"]] == [
        "technical", "quant", "regime", "fundamental", "news", "sentiment", "ml", "portfolio", "risk"]
    assert run["decision"] in ("BUY", "NO_TRADE")
    assert run["decision"] == "BUY" or run["reasons"]           # NO_TRADE is always explained
    assert run["context"]["account"]["id"] == acct["id"] and run["context"]["bars_1h"] > 100
    assert run["account_id"] == acct["id"]
    assert all(f["evidence"] or f["status"] != "ok" for f in run["findings"])

    listing = (await client.get(f"{API}/ai/runs", headers=h)).json()
    assert listing["total"] == 1 and listing["items"][0]["id"] == run["id"]
    detail = (await client.get(f"{API}/ai/runs/{run['id']}", headers=h)).json()
    assert detail["findings"] == run["findings"]
    async with new_client() as other:
        oh = await auth_headers(other, email="other@example.com")
        assert (await other.get(f"{API}/ai/runs/{run['id']}", headers=oh)).status_code == 404
        r = await other.post(f"{API}/ai/run", headers=oh, json={"symbol": "BTC-USD", "account_id": acct["id"]})
        assert r.status_code == 404  # cannot borrow someone else's account
    ah = await admin_headers(client)
    audit = (await client.get(f"{API}/admin/audit?action=ai.run", headers=ah)).json()
    assert audit["total"] == 1 and audit["items"][0]["details"]["symbol"] == "BTC-USD"


async def test_trend_produces_pending_proposal_that_can_be_dismissed(client):
    market_service.set_provider("synthetic", TrendProvider())
    h, acct = await funded(client)
    run = (await client.post(f"{API}/ai/run", headers=h, json={"symbol": "BTC-USD"})).json()
    assert run["decision"] == "BUY", run["reasons"]
    p = run["proposal"]
    assert p["status"] == "PENDING_RISK_REVIEW" and p["effective_status"] == "PENDING_RISK_REVIEW"
    assert p["risk_check_required"] is True and p["strategy_id"] == "consensus_trend_v1"
    assert Decimal(p["stop_loss"]) < Decimal(p["entry_price"]) < Decimal(p["take_profit"])
    assert Decimal(p["risk_amount"]) <= Decimal("500.00")
    assert Decimal(p["notional"]) <= Decimal("20000.00") and p["account_currency"] == "USD"

    # Research and agents never touch the ledger: cash is unchanged.
    bal = (await client.get(f"{API}/accounts/{acct['id']}", headers=h)).json()
    assert Decimal(bal["cash_balance"]) == Decimal("100000")

    props = (await client.get(f"{API}/ai/proposals", headers=h)).json()
    assert props["total"] == 1
    r = await client.post(f"{API}/ai/proposals/{p['id']}/dismiss", headers=h)
    assert r.status_code == 200 and r.json()["status"] == "DISMISSED"
    assert (await client.post(f"{API}/ai/proposals/{p['id']}/dismiss", headers=h)).status_code == 422

    async with SessionLocal() as db:   # expiry is reported, not silently executed
        await db.execute(text("UPDATE trade_proposals SET status='PENDING_RISK_REVIEW', "
                              "expires_at = now() - interval '1 minute'"))
        await db.commit()
    props = (await client.get(f"{API}/ai/proposals", headers=h)).json()
    assert props["items"][0]["effective_status"] == "EXPIRED"


async def test_no_account_means_no_proposal(client):
    market_service.set_provider("synthetic", TrendProvider())
    h = await auth_headers(client)
    run = (await client.post(f"{API}/ai/run", headers=h, json={"symbol": "BTC-USD"})).json()
    assert run["decision"] == "NO_TRADE" and run["proposal"] is None
    assert any("position cannot be sized" in r for r in run["reasons"])
    portfolio = next(f for f in run["findings"] if f["agent"] == "portfolio")
    assert portfolio["status"] == "abstain"


async def test_admin_agent_configuration(client):
    h, _ = await funded(client)
    assert (await client.patch(f"{API}/ai/agents/news", headers=h, json={"enabled": False})).status_code == 403
    ah = await admin_headers(client)
    r = await client.patch(f"{API}/ai/agents/news", headers=ah, json={"enabled": False, "weight": 0.2})
    assert r.status_code == 200 and r.json()["enabled"] is False and r.json()["weight"] == 0.2
    assert (await client.patch(f"{API}/ai/agents/risk", headers=ah, json={"enabled": False})).status_code == 422
    assert (await client.patch(f"{API}/ai/agents/regime", headers=ah, json={"weight": 0.5})).status_code == 422
    assert (await client.patch(f"{API}/ai/agents/nope", headers=ah, json={"enabled": False})).status_code == 404
    run = (await client.post(f"{API}/ai/run", headers=h, json={"symbol": "ETH-USD"})).json()
    news = next(f for f in run["findings"] if f["agent"] == "news")
    assert news["status"] == "abstain" and "disabled" in news["summary"]
    assert "news" not in run["weights"]


async def test_unknown_symbol(client):
    h, _ = await funded(client)
    assert (await client.post(f"{API}/ai/run", headers=h, json={"symbol": "NOPE"})).status_code == 404
