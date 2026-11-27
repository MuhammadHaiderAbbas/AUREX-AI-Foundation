"""Live Coinbase ticker feed (server-side quotes)."""

import time
from decimal import Decimal as D

from app.market import tickbars


def test_parse_ticker():
    m = {"type": "ticker", "product_id": "BTC-USD", "price": "60000.5", "last_size": "0.01", "time": "2026-01-01T12:00:01.5Z"}
    p, t, price, size = tickbars.parse_ticker(m)
    assert p == "BTC-USD" and price == D("60000.5") and size == D("0.01") and t.tzinfo is not None
    assert tickbars.parse_ticker({"type": "subscriptions"}) is None
    assert tickbars.parse_ticker({**m, "price": "x"}) is None


def test_latest_ticker_expires():
    tickbars.LATEST["ETH-USD"] = (time.monotonic(), {"price": "1"})
    try:
        assert tickbars.latest_ticker("ETH-USD") == {"price": "1"}
        tickbars.LATEST["ETH-USD"] = (time.monotonic() - 31, {"price": "1"})
        assert tickbars.latest_ticker("ETH-USD") is None
        assert tickbars.latest_ticker("NOPE") is None
    finally:
        tickbars.LATEST.clear()
