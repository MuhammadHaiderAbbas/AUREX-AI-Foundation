"""Futures bot: opens only on a validated signal, exits on its stop or after 4 hours, guards and pauses."""

from datetime import UTC, datetime, timedelta

from sqlalchemy import text

from app.database.session import SessionLocal
from app.futures import bot as fbot
from tests.conftest import API
from tests.test_binary import small_account
from tests.test_futures import D, synthetic_books  # noqa: F401  (autouse fixture)
from tests.test_trading import fake_quotes, set_price  # noqa: F401  (autouse fixture)


def _signal(trade=True, direction="LONG", lev=4, stop=2.0):
    async def fake(db, symbol):
        return {"trade": trade, "direction": direction if trade else None, "p_up": 0.62, "confidence": 0.62, "trades": 80, "hit_rate": 0.56,
                "mean_return": 0.004, "return_lower": 0.001, "folds": 5, "folds_profitable": 4, "suggested_leverage": lev,
                "stop_distance_pct": stop, "reason": "edge validated (test)" if trade else "no proven edge after costs (test)"}
    return fake


async def _start(client, h, aid, **kw):
    r = await client.post(f"{API}/futures/bot", headers=h, json={"account_id": aid, "action": "start", "symbols": ["BTC-USD"], **kw})
    assert r.status_code == 200, r.text
    return r.json()


async def _open_bot_rows(client, h, aid):
    rows = (await client.get(f"{API}/futures/positions", headers=h, params={"account_id": aid})).json()
    return [r for r in rows if r["source"] == "bot"]


async def test_bot_opens_with_capped_leverage_stop_and_time_exit(client, monkeypatch):
    monkeypatch.setattr(fbot, "signal_for", _signal(lev=4))
    h, aid = await small_account(client, email="fbot1@example.com")
    set_price("BTC-USD", "50000", spread="0")
    b = await _start(client, h, aid, margin_pct=5, max_leverage=3)
    assert b["status"] == "RUNNING" and b["stats"]["trades"] == 1 and b["recent"][0]["type"] == "FUTURES_BOT_CYCLE"
    p = (await _open_bot_rows(client, h, aid))[0]
    assert p["side"] == "LONG" and p["leverage"] == 3 and D(p["margin"]) == D("5.00")          # 5% of £100, leverage capped at 3
    assert D(p["stop_price"]) == D("49000")                                                     # 2% stop below entry
    assert p["signal"]["reason"] == "edge validated (test)"

    run = (await client.post(f"{API}/futures/bot/run?account_id={aid}", headers=h)).json()
    assert run["results"][0]["outcome"] == "holding"                                           # one bot position per market

    # the time exit closes it after the 4-hour horizon
    async with SessionLocal() as db:
        await db.execute(text("UPDATE futures_positions SET exit_due_at = now() - interval '1 minute'"))
        await db.commit()
    async with SessionLocal() as db:
        assert await fbot.manage_exits(db) == 1
        await db.commit()
    p = (await _open_bot_rows(client, h, aid))[0]
    assert p["status"] == "CLOSED" and p["exit_reason"] == "time"


async def test_stop_loss_closes_before_liquidation(client, monkeypatch):
    monkeypatch.setattr(fbot, "signal_for", _signal(direction="SHORT", lev=3, stop=2.0))
    h, aid = await small_account(client, email="fbot2@example.com")
    set_price("BTC-USD", "50000", spread="0")
    await _start(client, h, aid)
    set_price("BTC-USD", "51500", spread="0")                         # +3%: past the 2% stop, far from liquidation
    async with SessionLocal() as db:
        assert await fbot.manage_exits(db) == 1
        await db.commit()
    p = (await _open_bot_rows(client, h, aid))[0]
    assert p["status"] == "CLOSED" and p["exit_reason"] == "stop" and D(p["realised_pnl"]) < 0
    assert D(p["realised_pnl"]) > -D(p["margin"])                    # lost part of the margin, not all of it


async def test_no_signal_no_trade_and_risk_block_pauses(client, monkeypatch):
    monkeypatch.setattr(fbot, "signal_for", _signal(trade=False))
    h, aid = await small_account(client, email="fbot3@example.com")
    b = await _start(client, h, aid)
    assert b["stats"]["trades"] == 0
    assert b["recent"][0]["results"][0]["outcome"] == "no_trade"
    r = await client.post(f"{API}/risk/accounts/{aid}/kill-switch", headers=h, json={"engaged": True, "reason": "test"})
    assert r.status_code == 200, r.text
    b = (await client.get(f"{API}/futures/bot", headers=h, params={"account_id": aid})).json()
    assert b["status"] == "PAUSED" and "kill switch" in b["paused_reason"]


async def test_edge_guard_pauses_a_losing_bot(client, monkeypatch):
    monkeypatch.setattr(fbot, "signal_for", _signal())
    h, aid = await small_account(client, email="fbot4@example.com")
    set_price("BTC-USD", "50000", spread="0")
    await _start(client, h, aid, margin_pct=2)
    # eight losing bot trades in a row
    for i in range(8):
        if i:
            async with SessionLocal() as db:
                await db.execute(text("UPDATE futures_bots SET last_cycle_at = NULL"))
                await db.commit()
            assert (await client.post(f"{API}/futures/bot/run?account_id={aid}", headers=h)).json()["results"][0]["outcome"] == "opened"
        set_price("BTC-USD", "48900" if i % 2 == 0 else "48800", spread="0")
        async with SessionLocal() as db:
            assert await fbot.manage_exits(db) == 1
            await db.commit()
        set_price("BTC-USD", "50000", spread="0")
    run = (await client.post(f"{API}/futures/bot/run?account_id={aid}", headers=h)).json()
    assert "edge guard" in run["skipped"]
    b = (await client.get(f"{API}/futures/bot", headers=h, params={"account_id": aid})).json()
    assert b["status"] == "PAUSED" and b["stats"]["closed"] == 8 and b["stats"]["stopped"] == 8


async def test_controls_and_worker_cycle(client, monkeypatch):
    monkeypatch.setattr(fbot, "signal_for", _signal(trade=False))
    h, aid = await small_account(client, email="fbot5@example.com")
    await _start(client, h, aid)
    assert (await client.post(f"{API}/futures/bot", headers=h, json={"account_id": aid, "action": "pause"})).json()["status"] == "PAUSED"
    assert (await client.post(f"{API}/futures/bot/run?account_id={aid}", headers=h)).status_code == 422
    await _start(client, h, aid)
    async with SessionLocal() as db:
        await db.execute(text("UPDATE futures_bots SET last_cycle_at = :t"), {"t": datetime.now(UTC) - timedelta(hours=1)})
        await db.commit()
    async with SessionLocal() as db:
        due = await fbot.due_bots(db)
        assert len(due) == 1
        await fbot.run_bot_cycle(db, *due[0])
        await db.commit()
    assert (await client.post(f"{API}/futures/bot", headers=h, json={"account_id": aid, "action": "stop"})).json()["status"] == "STOPPED"
    bad = await client.post(f"{API}/futures/bot", headers=h, json={"account_id": aid, "action": "start", "max_leverage": 11})
    assert bad.status_code == 422
