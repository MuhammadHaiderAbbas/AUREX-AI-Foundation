"""Live account stream: auth, valuation ticks, and change topics for fills made elsewhere."""

import os

from fastapi.testclient import TestClient

from app.api.v1.stream import changed_topics
from app.core.config import get_settings
from app.main import app
from tests.conftest import API, auth_headers


def test_changed_topics():
    a = {"orders": (1, "t1"), "ledger": 3, "binary": (0, None)}
    assert changed_topics(None, a) == []
    assert changed_topics(a, {**a, "ledger": 4, "orders": (2, "t2")}) == ["orders", "ledger"]


def _until(ws, pred, limit=40):
    for _ in range(limit):
        msg = ws.receive_json()
        if pred(msg):
            return msg
    raise AssertionError("expected message not received")


async def test_account_stream(client):
    h = await auth_headers(client)
    token = h["Authorization"].split()[1]
    aid = (await client.post(f"{API}/accounts", headers=h, json={"name": "Live", "base_currency": "GBP",
                                                               "starting_balance": "100"})).json()["id"]
    os.environ["AUREX_ACCOUNT_STREAM_INTERVAL_SECONDS"] = "0.2"
    os.environ["AUREX_ACCOUNT_VALUATION_INTERVAL_SECONDS"] = "0.2"
    get_settings.cache_clear()
    try:
        with TestClient(app) as tc:
            with tc.websocket_connect(f"{API}/stream/account") as ws:
                ws.send_json({"type": "auth", "token": "nope"})
                assert ws.receive_json()["type"] == "error"
            with tc.websocket_connect(f"{API}/stream/account") as ws:
                ws.send_json({"type": "auth", "token": token})
                ready = ws.receive_json()
                assert ready["type"] == "ready" and ready["accounts"] == [aid]
                v = _until(ws, lambda m: m["type"] == "valuation")
                assert v["account_id"] == aid and float(v["equity"]) == 100 and v["positions"] == []
                # a deposit made through the API shows up as a ledger change
                r = await client.post(f"{API}/accounts/{aid}/deposits", headers=h, json={"amount": "5"})
                assert r.status_code in (200, 201), r.text
                ch = _until(ws, lambda m: m["type"] == "changed")
                assert ch["account_id"] == aid and "ledger" in ch["topics"]
                v = _until(ws, lambda m: m["type"] == "valuation" and float(m["equity"]) == 105)
                assert float(v["cash"]) == 105
    finally:
        for k in ("AUREX_ACCOUNT_STREAM_INTERVAL_SECONDS", "AUREX_ACCOUNT_VALUATION_INTERVAL_SECONDS"):
            os.environ.pop(k, None)
        get_settings.cache_clear()
