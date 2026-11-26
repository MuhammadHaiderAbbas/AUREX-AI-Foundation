"""Binary bot: the edge gate, the cycle, the edge guard, risk pauses and privacy."""

import math
from datetime import UTC, datetime, timedelta

import numpy as np
from sqlalchemy import text

from app.binary import bot as botmod
from app.database.session import SessionLocal
from tests.conftest import API, auth_headers, new_client
from tests.test_binary import expire_all, small_account
from tests.test_trading import fake_quotes, set_price  # noqa: F401  (autouse fixture)


def _series(closes: np.ndarray):
    t0 = datetime(2026, 1, 1, tzinfo=UTC)
    times = [t0 + timedelta(minutes=5 * i) for i in range(len(closes))]
    return times, list(closes * 1.001), list(closes * 0.999), list(closes)


def test_random_walk_has_no_edge_so_the_bot_does_not_trade():
    trades = 0
    for seed in range(20):
        rng = np.random.default_rng(seed)
        closes = 100 * np.exp(np.cumsum(rng.normal(0, 0.002, 1200)))
        sig = botmod.compute_signal(*_series(closes), 1, payout=0.8, min_confidence=0.6, edge_margin=0.02)
        trades += sig["trade"]
        assert sig["break_even"] == 1 / 1.8
    assert trades <= 1          # a coin-flip market should (almost) never pass the out-of-sample gate


def test_predictable_series_passes_the_gate():
    i = np.arange(1200)
    closes = 100 + 5 * np.sin(2 * math.pi * i / 40) + 0.01 * i
    sig = botmod.compute_signal(*_series(closes), 1, payout=0.8, min_confidence=0.6, edge_margin=0.02)
    assert sig["holdout_accuracy"] > 0.8 and sig["holdout_n"] >= 30
    assert sig["expected_return"] > 0
    assert sig["reason"].startswith(("edge validated", "not confident enough"))


def _fake_signal(direction="HIGHER", trade=True):
    async def fake(db, symbol, expiry_seconds, bot=None):
        return {"trade": trade, "direction": direction, "p_up": 0.7 if direction == "HIGHER" else 0.3, "confidence": 0.7,
                "holdout_accuracy": 0.65, "holdout_n": 120, "required_accuracy": 0.576, "expected_return": 0.17,
                "timeframe": "1m", "data_mode": "synthetic", "symbol": symbol,
                "reason": "edge validated (test)" if trade else "no validated edge (test)"}
    return fake


async def test_one_button_bot_cycle_guard_and_controls(client, monkeypatch):
    monkeypatch.setattr(botmod, "signal_for", _fake_signal())
    h, aid = await small_account(client, balance="1000")     # 0.2% stakes: five losses stay inside the 2% daily breaker
    set_price("BTC-USD", "50000", spread="0")
    r = await client.post(f"{API}/binary/bot", headers=h, json={"account_id": aid, "action": "start", "symbols": ["BTC-USD"],
                                                                "expiry_seconds": 60, "stake_pct": 0.2})
    assert r.status_code == 200, r.text
    b = r.json()
    assert b["status"] == "RUNNING" and b["stats"]["contracts"] == 1 and b["break_even_win_rate"] == 1 / 1.8
    items = (await client.get(f"{API}/binary/contracts?account_id={aid}", headers=h)).json()["items"]
    assert float(items[0]["stake"]) == 2.0                                            # 0.2% of £1,000
    async with SessionLocal() as db:
        src, sig = (await db.execute(text("SELECT source, signal FROM binary_contracts"))).one()
        dec = await db.scalar(text("SELECT count(*) FROM risk_decisions WHERE source = 'binary-bot' AND approved"))
    assert src == "bot" and sig["holdout_accuracy"] == 0.65 and dec == 1

    run = (await client.post(f"{API}/binary/bot/run?account_id={aid}", headers=h)).json()
    assert run["results"][0]["outcome"] == "waiting"                                 # one open contract per instrument

    # five losing contracts in a row: the edge guard pauses the bot
    async with SessionLocal() as db:
        await db.execute(text("UPDATE binary_bots SET guard_min_contracts = 5"))
        await db.commit()
    for i in range(5):
        if i:
            assert (await client.post(f"{API}/binary/bot/run?account_id={aid}", headers=h)).json()["results"][0]["outcome"] == "opened"
        await expire_all()
        set_price("BTC-USD", "49900", spread="0")
        await client.get(f"{API}/binary/contracts?account_id={aid}", headers=h)        # settles them (LOST)
        set_price("BTC-USD", "50000", spread="0")
    run = (await client.post(f"{API}/binary/bot/run?account_id={aid}", headers=h)).json()
    assert "edge guard" in run["skipped"]
    b = (await client.get(f"{API}/binary/bot?account_id={aid}", headers=h)).json()
    assert b["status"] == "PAUSED" and "below the 55.6% break-even" in b["paused_reason"]
    assert b["stats"]["lost"] == 5 and b["stats"]["win_rate"] == 0 and float(b["stats"]["net_pnl"]) == -9.94      # stakes shrink with equity
    assert any(c["type"] == "BINARY_BOT_PAUSED" for c in b["recent"])
    assert (await client.post(f"{API}/binary/bot/run?account_id={aid}", headers=h)).status_code == 422   # not running

    # restarting after a pause keeps the guard window; stop then start opens a fresh one
    await client.post(f"{API}/binary/bot", headers=h, json={"account_id": aid, "action": "stop"})
    b = (await client.post(f"{API}/binary/bot", headers=h, json={"account_id": aid, "action": "start"})).json()
    assert b["status"] == "RUNNING" and b["stats"]["lost"] == 0

    # the kill switch pauses it; the emergency stop stops it
    await client.post(f"{API}/risk/accounts/{aid}/kill-switch", headers=h, json={"engaged": True, "reason": "drill"})
    b = (await client.get(f"{API}/binary/bot?account_id={aid}", headers=h)).json()
    assert b["status"] == "PAUSED" and "kill switch" in b["paused_reason"]
    await client.post(f"{API}/risk/accounts/{aid}/emergency-stop", headers=h, json={"flatten": False})
    assert (await client.get(f"{API}/binary/bot?account_id={aid}", headers=h)).json()["status"] == "STOPPED"

    async with SessionLocal() as db:
        n = await db.scalar(text("SELECT count(*) FROM audit_logs WHERE action LIKE 'binary.bot.%'"))
    assert n == 3


async def test_bot_respects_limits_and_no_edge(client, monkeypatch):
    monkeypatch.setattr(botmod, "signal_for", _fake_signal(trade=False))
    h, aid = await small_account(client)
    b = (await client.post(f"{API}/binary/bot", headers=h, json={"account_id": aid, "action": "start", "symbols": ["BTC-USD", "ETH-USD"],
                                                                 "expiry_seconds": 300})).json()
    assert b["stats"]["contracts"] == 0
    assert b["recent"][0]["results"][0]["outcome"] == "no_trade"
    assert (await client.post(f"{API}/binary/bot", headers=h, json={"account_id": aid, "action": "start", "expiry_seconds": 61})).status_code == 422
    assert (await client.post(f"{API}/binary/bot", headers=h, json={"account_id": aid, "action": "start", "stake_pct": 6})).status_code == 422
    # binaries switched off in the Risk Centre pause the bot
    await client.put(f"{API}/risk/accounts/{aid}/limits", headers=h, json={"binary_enabled": False})
    monkeypatch.setattr(botmod, "signal_for", _fake_signal())
    r = (await client.post(f"{API}/binary/bot/run?account_id={aid}", headers=h)).json()
    assert "switched off" in r["skipped"]
    async with new_client() as other:
        oh = await auth_headers(other, email="snoop@example.com")
        assert (await other.get(f"{API}/binary/bot?account_id={aid}", headers=oh)).status_code == 404
        assert (await other.post(f"{API}/binary/bot", headers=oh, json={"account_id": aid, "action": "stop"})).status_code == 404


async def test_signal_endpoint_and_worker(client, monkeypatch):
    h, aid = await small_account(client)
    sig = (await client.get(f"{API}/binary/signal?symbol=BTC-USD&expiry_seconds=300", headers=h)).json()
    assert {"trade", "reason", "holdout_accuracy", "break_even", "data_mode", "timeframe"} <= set(sig)
    assert sig["timeframe"] == "5m" and sig["data_mode"] == "synthetic"
    monkeypatch.setattr(botmod, "signal_for", _fake_signal())
    await client.post(f"{API}/binary/bot", headers=h, json={"account_id": aid, "action": "start", "symbols": ["BTC-USD"], "expiry_seconds": 60})
    async with SessionLocal() as db:
        await db.execute(text("UPDATE binary_bots SET last_cycle_at = now() - interval '2 minutes'"))
        await db.commit()
    from app.ops import worker
    await expire_all()
    out = await worker.one_pass()
    assert out["binary"]["settled"] == 1
    b = (await client.get(f"{API}/binary/bot?account_id={aid}", headers=h)).json()
    assert b["stats"]["contracts"] == 2           # the worker ran the next cycle and opened another
