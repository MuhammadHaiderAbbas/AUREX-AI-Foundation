"""Binary bot: the edge gate, the cycle, the edge guard, risk pauses and privacy."""

import math
from datetime import UTC, datetime, timedelta

import numpy as np
import pytest
from sqlalchemy import text

from app.binary import bot as botmod
from app.database.session import SessionLocal
from app.futures import bot as fbot
from tests.conftest import API, auth_headers, new_client
from tests.test_binary import expire_all, small_account
from tests.test_trading import fake_quotes, set_price  # noqa: F401  (autouse fixture)


def _futures(direction="LONG", confidence=0.66, trade=False):
    async def fake(db, symbol):
        return {"direction": direction, "confidence": confidence, "trade": trade, "reason": "test"}
    return fake


@pytest.fixture(autouse=True)
def futures_agrees_by_default(monkeypatch):
    """The binary tests' fake signal is HIGHER; the futures model agrees unless a test says otherwise."""
    monkeypatch.setattr(fbot, "signal_for", _futures())


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


async def test_thirty_second_expiry_is_not_offered(client):
    h, aid = await small_account(client)
    assert 30 not in (await client.get(f"{API}/binary/config", headers=h)).json()["expiries"]
    r = await client.post(f"{API}/binary/bot", headers=h, json={"account_id": aid, "action": "stop", "expiry_seconds": 30})
    assert r.status_code == 422
    c = await client.post(f"{API}/binary/contracts", headers=h, json={"account_id": aid, "symbol": "BTC-USD", "direction": "HIGHER",
                                                                      "stake": "1", "expiry_seconds": 30, "client_id": "thirty-1"})
    assert c.status_code == 422


def test_cycle_interval_tracks_expiry():
    mk = lambda e: botmod.BinaryBot(expiry_seconds=e)  # noqa: E731
    assert botmod.cycle_interval(mk(60)) == 20
    assert botmod.cycle_interval(mk(300)) == 60 and botmod.cycle_interval(mk(86400)) == 60


async def test_new_bot_defaults_to_btc_and_eth_at_one_minute(client):
    h, aid = await small_account(client)
    b = (await client.get(f"{API}/binary/bot?account_id={aid}", headers=h)).json()
    assert b["symbols"] == ["BTC-USD", "ETH-USD"] and b["expiry_seconds"] == 60 and b["status"] == "STOPPED"


MIGRATION_0016 = (__import__("pathlib").Path(__file__).parent.parent / "alembic/versions/0016_bot_defaults_btc_eth_1m.py").read_text()


async def test_migration_moves_bots_on_old_defaults(client):
    h, aid = await small_account(client)
    await client.get(f"{API}/binary/bot?account_id={aid}", headers=h)          # creates the bot row
    async with SessionLocal() as db:
        await db.execute(text("""UPDATE binary_bots SET symbols = '["BTC-USD", "ETH-USD", "EUR/USD"]', expiry_seconds = 300"""))
        sql = MIGRATION_0016.split('op.execute("""')[1].split('""")')[0]
        await db.execute(text(sql))
        rows = (await db.execute(text("SELECT symbols::text, expiry_seconds, status FROM binary_bots"))).all()
        await db.rollback()
    assert rows and all(r[0] == '["BTC-USD", "ETH-USD"]' and r[1] == 60 for r in rows if r[2] != "RUNNING")


def test_signal_with_no_history_does_not_crash():
    sig = botmod.compute_signal([], [], [], [], 1, payout=0.8, min_confidence=0.6, edge_margin=0.02)
    assert not sig["trade"] and sig["reason"].startswith("not enough history")


def test_wilson_bounds_need_evidence():
    lo, hi = botmod.wilson_bounds(1, 5)          # the screenshot's record: 1 win in 5
    assert lo < 0.06 and hi > 0.6                # five contracts say almost nothing either way
    lo, hi = botmod.wilson_bounds(70, 100)
    assert 0.6 < lo < 0.7 < hi < 0.8
    assert botmod.wilson_bounds(0, 0) == (0.0, 1.0)


def test_a_lucky_small_sample_does_not_pass_the_gate():
    """Noise with an occasional streak: the old single-split check could pass; the walk-forward + confidence bound must not."""
    passed = 0
    for seed in range(12):
        rng = np.random.default_rng(100 + seed)
        closes = 100 * np.exp(np.cumsum(rng.normal(0, 0.0015, 2500)))
        sig = botmod.compute_signal(*_series(closes), 1, payout=0.8, min_confidence=0.55, edge_margin=0.02)
        passed += sig["trade"]
        if sig["holdout_n"]:
            assert sig["holdout_lower"] is not None and sig["folds"] >= 1
    assert passed == 0


async def test_early_statistical_guard_pauses_a_clearly_losing_bot(client, monkeypatch):
    monkeypatch.setattr(botmod, "signal_for", _fake_signal())
    h, aid = await small_account(client, email="early@example.com", balance="1000")
    set_price("BTC-USD", "50000", spread="0")
    await client.post(f"{API}/binary/bot", headers=h, json={"account_id": aid, "action": "start", "symbols": ["BTC-USD"],
                                                              "expiry_seconds": 60, "stake_pct": 0.1})
    for i in range(8):                            # eight straight losses: even the best case of that record is below break-even
        if i:
            assert (await client.post(f"{API}/binary/bot/run?account_id={aid}", headers=h)).json()["results"][0]["outcome"] == "opened"
        await expire_all()
        set_price("BTC-USD", "49900", spread="0")
        await client.get(f"{API}/binary/contracts?account_id={aid}", headers=h)
        set_price("BTC-USD", "50000", spread="0")
    run = (await client.post(f"{API}/binary/bot/run?account_id={aid}", headers=h)).json()
    assert "even the best case" in run["skipped"]
    assert (await client.get(f"{API}/binary/bot?account_id={aid}", headers=h)).json()["status"] == "PAUSED"


async def _start_btc(client, h, aid, **kw):
    r = await client.post(f"{API}/binary/bot", headers=h, json={"account_id": aid, "action": "start", "symbols": ["BTC-USD"], "expiry_seconds": 60, **kw})
    assert r.status_code == 200, r.text
    return r.json()


async def test_bot_trades_only_when_the_futures_model_agrees(client, monkeypatch):
    monkeypatch.setattr(botmod, "signal_for", _fake_signal("HIGHER"))
    h, aid = await small_account(client, email="agree@example.com")
    set_price("BTC-USD", "50000", spread="0")

    monkeypatch.setattr(fbot, "signal_for", _futures("SHORT", 0.70))            # disagrees
    b = await _start_btc(client, h, aid)
    r = b["recent"][0]["results"][0]
    assert b["stats"]["contracts"] == 0 and r["outcome"] == "no_trade" and "futures model disagrees" in r["detail"]
    assert r["signal"]["futures"]["direction"] == "SHORT"

    monkeypatch.setattr(fbot, "signal_for", _futures("LONG", 0.52))             # agrees, but not confidently
    r = (await client.post(f"{API}/binary/bot/run?account_id={aid}", headers=h)).json()["results"][0]
    assert r["outcome"] == "no_trade" and "only 52%" in r["detail"]

    monkeypatch.setattr(fbot, "signal_for", _futures("LONG", 0.64))             # agrees
    r = (await client.post(f"{API}/binary/bot/run?account_id={aid}", headers=h)).json()["results"][0]
    assert r["outcome"] == "opened" and "futures model agrees (64% LONG)" in r["detail"]
    async with SessionLocal() as db:
        sig = await db.scalar(text("SELECT signal FROM binary_contracts"))
    assert sig["futures"] == {"direction": "LONG", "confidence": 0.64, "trade": False}


async def test_lower_needs_a_short_and_the_check_can_be_switched_off(client, monkeypatch):
    monkeypatch.setattr(botmod, "signal_for", _fake_signal("LOWER"))
    h, aid = await small_account(client, email="agree2@example.com")
    set_price("BTC-USD", "50000", spread="0")
    b = await _start_btc(client, h, aid)                                        # futures stub says LONG
    assert b["require_futures_agreement"] is True and b["stats"]["contracts"] == 0
    await client.post(f"{API}/binary/bot", headers=h, json={"account_id": aid, "action": "stop"})
    b = await _start_btc(client, h, aid, require_futures_agreement=False)
    assert b["require_futures_agreement"] is False and b["stats"]["contracts"] == 1


async def test_non_crypto_markets_cannot_be_confirmed(client, monkeypatch):
    monkeypatch.setattr(botmod, "signal_for", _fake_signal("HIGHER"))
    h, aid = await small_account(client, email="agree3@example.com")
    r = await client.post(f"{API}/binary/bot", headers=h, json={"account_id": aid, "action": "start", "symbols": ["GBP/USD"], "expiry_seconds": 60})
    res = r.json()["recent"][0]["results"][0]
    assert res["outcome"] == "no_trade" and "crypto only" in res["detail"]


def _by_expiry(passing: dict[int, str]):
    """A fake model: trades only at the given expiries (direction per expiry), honest 'no edge' elsewhere."""
    async def fake(db, symbol, expiry_seconds, bot=None):
        d = passing.get(expiry_seconds)
        return {"trade": d is not None, "direction": d or "HIGHER", "p_up": 0.7, "confidence": 0.7, "holdout_accuracy": 0.66 if d else 0.51,
                "holdout_lower": 0.6 if d else 0.45, "holdout_n": 200, "folds": 5, "folds_beating": 5, "required_accuracy": 0.576,
                "expected_return": 0.1, "break_even": 1 / 1.8, "timeframe": "1m", "data_mode": "synthetic", "symbol": symbol,
                "reason": "edge validated (test)" if d else "no proven edge (test)"}
    return fake


async def test_scan_finds_the_expiry_with_an_edge(client, monkeypatch):
    botmod._sig_cache.clear()
    monkeypatch.setattr(botmod, "signal_for", _by_expiry({900: "HIGHER"}))
    monkeypatch.setattr(botmod, "scan_symbols", lambda db: _aw(["BTC-USD"]))
    h, aid = await small_account(client, email="scan1@example.com")
    set_price("BTC-USD", "50000", spread="0")
    b = (await client.post(f"{API}/binary/bot", headers=h, json={"account_id": aid, "action": "start", "scan": True})).json()
    assert b["scan"] is True and b["stats"]["contracts"] == 1
    r = b["recent"][0]["results"][0]
    assert r["outcome"] == "opened" and r["expiry_seconds"] == 900 and r["detail"].startswith("15m expiry")


async def _aw(v):
    return v


async def test_practice_mode_trades_a_guess_with_a_capped_stake(client, monkeypatch):
    botmod._sig_cache.clear()
    monkeypatch.setattr(botmod, "signal_for", _by_expiry({}))           # no edge anywhere
    h, aid = await small_account(client, email="practice1@example.com", balance="1000")
    set_price("BTC-USD", "50000", spread="0")
    b = (await client.post(f"{API}/binary/bot", headers=h, json={"account_id": aid, "action": "start", "symbols": ["BTC-USD"],
                                                                 "expiry_seconds": 60})).json()
    assert b["stats"]["contracts"] == 0                                   # careful: no edge, no trade
    await client.post(f"{API}/binary/bot", headers=h, json={"account_id": aid, "action": "stop"})
    b = (await client.post(f"{API}/binary/bot", headers=h, json={"account_id": aid, "action": "start", "risk_mode": "practice",
                                                                 "stake_pct": 3})).json()
    r = b["recent"][0]["results"][0]
    assert b["risk_mode"] == "practice" and r["outcome"] == "opened" and "NO proven edge" in r["detail"]
    assert float(r["stake"]) == 10.0                                      # capped at 1% of £1,000, not 3%
    assert r["signal"]["mode"] == "practice"
