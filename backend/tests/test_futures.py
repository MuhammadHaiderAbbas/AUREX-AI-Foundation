"""Paper futures: liquidation maths, order-book fills, open/close P&L, liquidation, funding, risk and the AI gate."""

import math
from datetime import UTC, datetime, timedelta
from decimal import Decimal

import numpy as np
import pytest
from sqlalchemy import text

from app.database.session import SessionLocal
from app.futures import book as obook
from app.futures import signal as fsig
from app.futures.service import FuturesService, liquidation_price, next_funding
from tests.conftest import API, admin_headers
from tests.test_binary import small_account
from tests.test_trading import PRICES, fake_quotes, set_price  # noqa: F401  (autouse fixture)


def D(x) -> Decimal:
    return Decimal(str(x))


@pytest.fixture(autouse=True)
def synthetic_books(monkeypatch):
    """Books built from the fake quotes, no cache, so a price change is seen at once."""
    async def book(svc, inst):
        p = PRICES[inst.symbol]
        return obook.synthetic_book(p["bid"], p["ask"])
    monkeypatch.setattr(obook, "book", book)


def test_liquidation_price_matches_the_leverage_formula():
    e, mmr = D("50000"), D("0.005")
    for lev in (2, 5, 10):
        qty = D(1)
        margin = e * qty / lev
        long_ = liquidation_price("LONG", e, qty, margin, mmr)
        short = liquidation_price("SHORT", e, qty, margin, mmr)
        assert long_ == pytest.approx(e * (1 - D(1) / lev + mmr))
        assert short == pytest.approx(e * (1 + D(1) / lev - mmr))


def test_walking_the_book_costs_slippage_and_refuses_too_big_orders():
    b = obook.synthetic_book(D("100"), D("100.02"))
    small = obook.walk(b["asks"], D("1"))
    assert small.levels == 1 and small.avg_price == D("100.02") and small.slippage_bps == 0
    big_qty = sum(s for _, s in b["asks"][:5])
    big = obook.walk(b["asks"], big_qty)
    assert big.levels == 5 and big.avg_price > D("100.02") and big.slippage_bps > 0
    assert obook.walk(b["asks"], sum(s for _, s in b["asks"]) + 1) is None


def test_next_funding_is_on_the_8_hour_grid():
    assert next_funding(datetime(2026, 1, 1, 3, 15, tzinfo=UTC)) == datetime(2026, 1, 1, 8, tzinfo=UTC)
    assert next_funding(datetime(2026, 1, 1, 16, 0, tzinfo=UTC)) == datetime(2026, 1, 2, 0, tzinfo=UTC)


async def _open(client, h, aid, side="LONG", margin="10.00", leverage=5, **kw):
    return await client.post(f"{API}/futures/positions", headers=h,
                             json={"account_id": aid, "symbol": "BTC-USD", "side": side, "margin": margin, "leverage": leverage, **kw})


async def _cash(client, h, aid):
    return D((await client.get(f"{API}/accounts/{aid}", headers=h)).json()["cash_balance"])


async def test_open_and_close_long_with_profit(client):
    h, aid = await small_account(client, email="fut1@example.com")
    set_price("BTC-USD", "50000", spread="0")
    pv = (await client.get(f"{API}/futures/preview", headers=h, params={"account_id": aid, "symbol": "BTC-USD", "side": "LONG",
                                                                        "margin": "10", "leverage": 5})).json()
    assert D(pv["avg_price"]) == D("50000") and D(pv["liquidation_price"]) < D("50000")
    r = await _open(client, h, aid)
    assert r.status_code == 201, r.text
    p = r.json()
    assert p["status"] == "OPEN" and p["leverage"] == 5 and D(p["margin"]) == D("10.00")
    # £10 x5 = £50 notional = $62.50 -> 0.00125 BTC; liquidation ~ 50000 * (1 - 1/5 + 0.005)
    assert D(p["liquidation_price"]) == pytest.approx(D("40250"), rel=D("0.001"))
    fee = D(p["fees"])
    assert fee > 0 and await _cash(client, h, aid) == D("100") - D("10") - fee
    assert all(c["passed"] for c in p["checks"])

    s = (await client.get(f"{API}/portfolio/summary", headers=h, params={"account_id": aid})).json()
    assert D(s["futures_margin"]) == D("10.00")

    set_price("BTC-USD", "55000", spread="0")                       # +10% move at 5x -> about +50% on margin
    lst = (await client.get(f"{API}/futures/positions", headers=h, params={"account_id": aid, "status": "open"})).json()
    assert lst[0]["roe_pct"] == pytest.approx(50, rel=0.02)
    c = (await client.post(f"{API}/futures/positions/{p['id']}/close", headers=h)).json()
    assert c["status"] == "CLOSED" and D(c["realised_pnl"]) == pytest.approx(D("5"), rel=D("0.02"))
    assert (await client.post(f"{API}/futures/positions/{p['id']}/close", headers=h)).status_code == 422


async def test_short_gains_when_price_falls_and_idempotency(client):
    h, aid = await small_account(client, email="fut2@example.com")
    set_price("BTC-USD", "50000", spread="0")
    a = await _open(client, h, aid, side="SHORT", leverage=2, client_id="k1")
    b = await _open(client, h, aid, side="SHORT", leverage=2, client_id="k1")
    assert a.status_code == 201 and b.status_code == 200 and a.json()["id"] == b.json()["id"]
    set_price("BTC-USD", "45000", spread="0")
    c = (await client.post(f"{API}/futures/positions/{a.json()['id']}/close", headers=h)).json()
    assert D(c["realised_pnl"]) == pytest.approx(D("2"), rel=D("0.02"))             # -10% at 2x on £10 = +£2


async def test_liquidation_loses_only_the_margin(client):
    h, aid = await small_account(client, email="fut3@example.com")
    set_price("BTC-USD", "50000", spread="0")
    p = (await _open(client, h, aid, leverage=10)).json()
    cash_after_open = await _cash(client, h, aid)
    set_price("BTC-USD", "44000", spread="0")                       # below ~45,250
    async with SessionLocal() as db:
        assert await FuturesService(db).check_liquidations() == 1
        await db.commit()
    rows = (await client.get(f"{API}/futures/positions", headers=h, params={"account_id": aid, "status": "closed"})).json()
    assert rows[0]["status"] == "LIQUIDATED" and D(rows[0]["realised_pnl"]) == D("-10.00")
    assert await _cash(client, h, aid) == cash_after_open           # margin gone, nothing more taken
    assert p["id"] == rows[0]["id"]


async def test_funding_moves_margin_from_longs_to_shorts(client):
    h, aid = await small_account(client, email="fut4@example.com")
    set_price("BTC-USD", "50000", spread="0")
    long_ = (await _open(client, h, aid, side="LONG")).json()
    short = (await _open(client, h, aid, side="SHORT")).json()
    async with SessionLocal() as db:
        await db.execute(text("UPDATE futures_positions SET last_funding_at = now() - interval '9 hours'"))
        await db.commit()
    async with SessionLocal() as db:
        assert await FuturesService(db).apply_funding() == 2
        assert await FuturesService(db).apply_funding() == 0          # not due again yet
        await db.commit()
    rows = {r["id"]: r for r in (await client.get(f"{API}/futures/positions", headers=h, params={"account_id": aid})).json()}
    assert D(rows[long_["id"]]["funding"]) < 0 < D(rows[short["id"]]["funding"])
    assert D(rows[long_["id"]]["margin"]) < D("10") < D(rows[short["id"]]["margin"])
    assert D(rows[long_["id"]]["liquidation_price"]) > D(long_["liquidation_price"])   # less margin -> closer liquidation


async def test_risk_checks_reject_and_are_recorded(client):
    h, aid = await small_account(client, email="fut5@example.com")
    set_price("BTC-USD", "50000", spread="0")
    r = await _open(client, h, aid, margin="30.00")                 # above 20% of equity
    assert r.status_code == 422 and "20% of equity" in r.json()["error"]["message"]
    assert (await _open(client, h, aid, leverage=11)).status_code == 422    # above the 10x maximum
    r = await client.post(f"{API}/futures/positions", headers=h, json={"account_id": aid, "symbol": "AAPL", "side": "LONG",
                                                                         "margin": "5.00", "leverage": 2})
    assert r.status_code == 422 and "crypto" in r.json()["error"]["message"]
    set_price("BTC-USD", "50000", spread="0", stale=True)
    assert (await _open(client, h, aid)).status_code == 422
    async with SessionLocal() as db:
        n = await db.scalar(text("SELECT count(*) FROM risk_decisions WHERE source = 'futures' AND NOT approved"))
    assert n >= 2


async def test_admins_cannot_trade_futures(client):
    h = await admin_headers(client)
    assert (await client.get(f"{API}/futures/config", headers=h)).status_code == 403


def _hourly(closes):
    t0 = datetime(2026, 1, 1, tzinfo=UTC)
    return [t0 + timedelta(hours=i) for i in range(len(closes))], list(closes * 1.002), list(closes * 0.998), list(closes)


def test_futures_ai_does_not_trade_noise():
    trades = 0
    for seed in range(10):
        rng = np.random.default_rng(seed)
        closes = 100 * np.exp(np.cumsum(rng.normal(0, 0.006, 2000)))
        sig = fsig.compute(*_hourly(closes), fee=0.0005, funding_8h=0.0001, max_leverage=10)
        trades += sig["trade"]
        assert sig["cost_per_trade"] == pytest.approx(0.00105)
        assert 1 <= sig["suggested_leverage"] <= 5
    assert trades <= 1


def test_futures_ai_finds_a_real_pattern():
    i = np.arange(2000)
    closes = 100 + 6 * np.sin(2 * math.pi * i / 48) + 0.002 * i
    sig = fsig.compute(*_hourly(closes), fee=0.0005, funding_8h=0.0001, max_leverage=10)
    assert sig["trades"] >= 40 and sig["mean_return"] > 0 and sig["return_lower"] > 0
