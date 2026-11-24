"""Phase 10: analytics endpoints over real trades, snapshots, risk logs and agent runs."""

import hashlib
import json
from datetime import UTC, datetime, timedelta
from decimal import Decimal as D

import pytest
from sqlalchemy import text

from app.api.v1.analytics import _csv
from app.database.session import SessionLocal
from app.models import AIRun, PortfolioSnapshot
from tests.conftest import API, admin_headers, auth_headers, new_client
from tests.test_risk_api import process
from tests.test_trading import PRICES, fake_quotes, order, set_price, setup  # noqa: F401 (fixture)


async def backdate(aid: str, days: int, equity_path: list[float]):
    """Pretend the account is `days` old with one snapshot per day along `equity_path`."""
    # anchored to UTC midnight so each snapshot lands on its own calendar day whatever the time of day
    midnight = datetime.now(UTC).replace(hour=0, minute=0, second=0, microsecond=0)
    start = midnight - timedelta(days=days)
    async with SessionLocal() as db:
        await db.execute(text("UPDATE trading_accounts SET created_at = :t WHERE id = :i"), {"t": start, "i": aid})
        for k, eq in enumerate(equity_path):
            db.add(PortfolioSnapshot(account_id=aid, taken_at=start + timedelta(days=k, hours=1), cash=D(str(eq)),
                                     market_value=D(0), equity=D(str(eq)), reason="periodic"))
        await db.commit()


async def get(client, h, aid, section, **params):
    q = "&".join(f"{k}={v}" for k, v in params.items())
    r = await client.get(f"{API}/analytics/accounts/{aid}/{section}?{q}", headers=h)
    assert r.status_code == 200, r.text
    return r.json()


async def round_trips(client, h, aid):
    """One manual win (AAPL +10%) and one stopped-out loss (MSFT bracket)."""
    await order(client, h, aid, qty="10")
    set_price("AAPL", "220")
    await order(client, h, aid, side="SELL", qty="10")
    await order(client, h, aid, symbol="MSFT", qty="5", stop_loss="390.00")
    set_price("MSFT", "385")
    await process(client)


async def test_performance_is_time_weighted_and_ignores_deposits(client):
    h, aid = await setup(client)
    path = [100000 * 1.001 ** k for k in range(30)]
    await backdate(aid, 30, path)
    await client.post(f"{API}/accounts/{aid}/deposits", headers=h, json={"amount": "10000"})
    p = await get(client, h, aid, "performance", period="all")
    mt = p["metrics"]
    assert mt["periods"] >= 29 and mt["sharpe"] is not None and mt["volatility"] is not None
    assert mt["max_drawdown"] <= 0 and 0 < mt["positive_days"] <= 1
    today = p["daily"][-1]
    assert today["flow"] == 10000
    assert today["return"] == pytest.approx((110000 - 10000) / path[-1] - 1, rel=1e-6)   # deposit is not a gain
    assert p["curve"][0]["equity"] == 100000 and p["curve"][-1]["equity"] == pytest.approx(110000)
    assert p["benchmark"]["symbol"] == "SPY" and p["benchmark"]["available"] is True and len(p["benchmark"]["curve"]) > 5
    short = await get(client, h, aid, "performance", period="7d")
    assert short["metrics"]["periods"] <= 7 and short["metrics"]["sharpe"] is None
    assert any("need at least 20" in n for n in short["notes"])
    assert (await client.get(f"{API}/analytics/accounts/{aid}/performance?period=2y", headers=h)).status_code == 422


async def test_trade_statistics_and_attribution(client):
    h, aid = await setup(client)
    await round_trips(client, h, aid)
    t = await get(client, h, aid, "trades", period="30d")
    s = t["stats"]
    assert s["trades"] == 2 and s["wins"] == 1 and s["losses"] == 1 and s["win_rate"] == 0.5
    win = next(x for x in t["trades"] if x["symbol"] == "AAPL")
    loss = next(x for x in t["trades"] if x["symbol"] == "MSFT")
    assert win["pnl"] > 180 and loss["pnl"] < 0 and loss["exit"] == "stop" and win["exit"] == "manual"
    assert s["profit_factor"] == pytest.approx(win["pnl"] / -loss["pnl"])
    assert s["net_pnl"] == pytest.approx(win["pnl"] + loss["pnl"]) and s["fees"] > 0
    assert {g["key"] for g in t["by_exit"]} == {"manual", "stop"} and t["by_source"][0]["key"] == "manual"
    assert t["by_asset_class"][0]["key"] == "STOCK" and t["by_asset_class"][0]["trades"] == 2
    bal = (await client.get(f"{API}/accounts/{aid}/balances", headers=h)).json()
    lines = {ln["code"]: D(ln["balance"]) for ln in bal["lines"]}
    assert s["net_pnl"] == pytest.approx(float(lines["REALISED_PNL"] - lines["FEES"]))   # reconciles with the ledger


async def test_execution_quality_and_rejection_reasons(client):
    h, aid = await setup(client)
    await round_trips(client, h, aid)
    await order(client, h, aid, qty="1000")                              # insufficient cash
    await order(client, h, aid, qty="100", stop_loss="219.00")           # risk: position size (22%)
    e = await get(client, h, aid, "execution", period="30d")
    tot = e["total"]
    assert tot["fills"] == 4 and tot["cost_bps"] > 0
    assert tot["total_cost"] == pytest.approx(tot["fees"] + tot["spread"] + tot["slippage"])
    assert tot["fee_bps"] == pytest.approx(1.0, rel=0.01)                  # stocks: 1bp commission
    assert {r["reason"] for r in e["rejections"]} == {"Insufficient cash", "Risk: Position size"}
    src = {r["source"]: r for r in e["orders"]["by_source"]}
    assert src["manual"]["FILLED"] == 3 and src["protective"]["FILLED"] == 1 and src["manual"]["REJECTED"] == 2
    assert 0 < e["orders"]["fill_rate"] < 1
    r = await get(client, h, aid, "risk", period="30d")
    assert r["rejected"] == 1 and r["failed_checks"][0]["check"] == "Position size"
    assert r["by_source"] == [{"source": "manual", "approved": 3, "rejected": 1}]


async def test_ai_signal_evaluation_uses_forward_prices(client):
    h, aid = await setup(client)
    me = (await client.get(f"{API}/auth/me", headers=h)).json()
    await backdate(aid, 10, [])
    now = datetime.now(UTC)
    async with SessionLocal() as db:
        for k, (decision, conf) in enumerate([("BUY", 0.8), ("BUY", 0.6), ("NO_TRADE", 0.2), ("BUY", 0.7)]):
            at = now - timedelta(days=3 - k * 0.5) if k < 3 else now - timedelta(hours=2)   # the last is too recent
            db.add(AIRun(user_id=me["id"], account_id=aid, symbol="BTC-USD", decision=decision, bias="bullish",
                         net_score=0.3, agreement=0.8, coverage=0.9, confidence=conf, reasons=[], weights={},
                         context={"quote": {"last": 50000.0}}, started_at=at, finished_at=at, latency_ms=5, created_at=at))
        await db.commit()
    a = await get(client, h, aid, "ai", period="30d", horizon_hours=24)
    sig = a["signals"]
    assert sig["runs"] == 4 and sig["pending"] == 1
    assert sig["buy"]["n"] == 2 and sig["no_trade"]["n"] == 1
    assert sig["buy"]["avg_forward_return"] is not None and sig["edge"] is not None
    assert sig["buy_calibration"]["n"] == 2
    assert a["proposals"]["total"] == 0 and a["realised"]["closed_trades"] == 0
    assert (await client.get(f"{API}/analytics/accounts/{aid}/ai?horizon_hours=500", headers=h)).status_code == 422


async def test_report_is_hashed_and_audited(client):
    h, aid = await setup(client)
    await round_trips(client, h, aid)
    rep = await get(client, h, aid, "report", period="30d")
    body = {k: v for k, v in rep.items() if k != "sha256"}
    assert rep["sha256"] == hashlib.sha256(json.dumps(body, sort_keys=True, default=str, separators=(",", ":")).encode()).hexdigest()
    assert rep["integrity"]["ledger_balanced"] is True and rep["trades"]["stats"]["trades"] == 2
    assert {"performance", "execution", "risk", "ai"} <= set(rep) and "curve" not in rep["performance"]
    r = await client.get(f"{API}/analytics/accounts/{aid}/report?period=30d&download=true", headers=h)
    assert r.headers["content-disposition"].startswith('attachment; filename="aurex-report-Paper-30d')
    ah = await admin_headers(client)
    audit = (await client.get(f"{API}/admin/audit?action=analytics.report", headers=ah)).json()
    assert audit["total"] == 2 and audit["items"][0]["details"]["sha256"]


async def test_csv_exports(client):
    h, aid = await setup(client)
    await round_trips(client, h, aid)
    expect = {"executions": 4, "orders": 4, "trades": 2, "decisions": 3, "equity": None, "ledger": None}
    for kind, n in expect.items():
        r = await client.get(f"{API}/analytics/accounts/{aid}/export/{kind}.csv?period=all", headers=h)
        assert r.status_code == 200 and r.headers["content-type"].startswith("text/csv"), kind
        lines = r.text.strip().split("\n")
        if n is not None:
            assert len(lines) == n + 1, (kind, lines)
    led = (await client.get(f"{API}/analytics/accounts/{aid}/export/ledger.csv", headers=h)).text
    assert "INITIAL_FUNDING" in led and "TRADE_SELL,Sell 10 AAPL" in led
    assert (await client.get(f"{API}/analytics/accounts/{aid}/export/secrets.csv", headers=h)).status_code == 404
    ah = await admin_headers(client)
    assert (await client.get(f"{API}/admin/audit?action=analytics.export", headers=ah)).json()["total"] == 7
    assert _csv(["a"], [["=HYPERLINK(1)"], ["-3.5"], ["@x"]]) == "a\n'=HYPERLINK(1)\n-3.5\n'@x\n"


async def test_analytics_are_private(client):
    h, aid = await setup(client)
    async with new_client() as other:
        oh = await auth_headers(other, email="other@example.com")
        for path in ("performance", "trades", "execution", "risk", "ai", "report", "export/orders.csv"):
            assert (await other.get(f"{API}/analytics/accounts/{aid}/{path}", headers=oh)).status_code == 404, path
    _ = PRICES
