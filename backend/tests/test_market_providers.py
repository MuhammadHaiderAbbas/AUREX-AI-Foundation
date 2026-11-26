import json
from datetime import UTC, datetime, timedelta
from decimal import Decimal

import httpx
import pytest

from app.market.providers.coinbase import CoinbaseProvider
from app.market.providers.frankfurter import FrankfurterProvider
from app.market.types import InstrumentRef, ProviderError, UnsupportedTimeframe

BTC = InstrumentRef("BTC-USD", "CRYPTO", "CRYPTO_24_7", "BTC-USD", 2, Decimal("90000"))
EUR = InstrumentRef("EUR/USD", "FX", "FX_24_5", "EUR/USD", 5, Decimal("1.08"))


def coinbase(handler) -> CoinbaseProvider:
    client = httpx.AsyncClient(base_url="https://cb.test", transport=httpx.MockTransport(handler))
    return CoinbaseProvider(client=client)


async def test_coinbase_candles_chunked_sorted_and_filtered():
    calls = []

    def handler(req: httpx.Request):
        calls.append(dict(req.url.params))
        start = datetime.fromisoformat(req.url.params["start"])
        end = datetime.fromisoformat(req.url.params["end"])
        rows, t = [], start
        while t < end:
            rows.append([int(t.timestamp()), 99, 102, 100, 101, 1.5])
            t += timedelta(hours=1)
        return httpx.Response(200, json=list(reversed(rows)))  # newest first, like upstream

    end = datetime(2026, 11, 20, tzinfo=UTC)
    start = end - timedelta(hours=400)
    out = await coinbase(handler).get_candles(BTC, "1h", start, end)
    assert len(calls) == 2  # 300-row upstream limit forces chunking
    assert len(out) == 400 and out == sorted(out, key=lambda c: c.open_time)
    assert out[0].open == Decimal("100") and out[0].high == Decimal("102")


async def test_coinbase_4h_is_aggregated_from_1h():
    def handler(req):
        assert req.url.params["granularity"] == "3600"
        start = datetime.fromisoformat(req.url.params["start"])
        rows = [[int((start + timedelta(hours=i)).timestamp()), 100 - i, 110 + i, 100 + i,
                 101 + i, 1] for i in range(8)]
        return httpx.Response(200, json=rows)

    start = datetime(2026, 11, 20, tzinfo=UTC)
    out = await coinbase(handler).get_candles(BTC, "4h", start, start + timedelta(hours=8))
    assert len(out) == 2
    first = out[0]
    assert first.open == Decimal("100") and first.close == Decimal("104")
    assert first.high == Decimal("113") and first.low == Decimal("97")
    assert first.volume == Decimal("4")


async def test_coinbase_quote_and_errors():
    def ok(req):
        if req.url.path.endswith("/ticker"):
            return httpx.Response(200, json={"price": "91000.5", "bid": "91000.1", "ask": "91000.9",
                                             "time": "2026-11-23T12:00:00.123Z"})
        return httpx.Response(200, json={"open": "90000"})

    q = await coinbase(ok).get_quote(BTC)
    assert q.last == Decimal("91000.5") and q.prev_close == Decimal("90000")
    assert q.as_of.tzinfo is not None and q.source == "coinbase"

    with pytest.raises(ProviderError):
        await coinbase(lambda r: httpx.Response(429, json={})).get_quote(BTC)
    with pytest.raises(ProviderError):
        await coinbase(lambda r: httpx.Response(200, json={"weird": 1})).get_quote(BTC)

    def boom(req):
        raise httpx.ConnectError("down")

    with pytest.raises(ProviderError, match="unreachable"):
        await coinbase(boom).get_quote(BTC)


def frankfurter(handler) -> FrankfurterProvider:
    client = httpx.AsyncClient(base_url="https://fx.test", transport=httpx.MockTransport(handler))
    return FrankfurterProvider(client=client)


async def test_frankfurter_daily_fixings():
    payload = {"rates": {"2026-11-18": {"USD": 1.0712}, "2026-11-19": {"USD": 1.07345678},
                         "2026-11-20": {"USD": 1.0751}}}

    def handler(req):
        assert req.url.params["base"] == "EUR" and req.url.params["symbols"] == "USD"
        return httpx.Response(200, content=json.dumps(payload))

    p = frankfurter(handler)
    start, end = datetime(2026, 11, 18, tzinfo=UTC), datetime(2026, 11, 21, tzinfo=UTC)
    out = await p.get_candles(EUR, "1d", start, end)
    assert [c.close for c in out] == [Decimal("1.07120"), Decimal("1.07346"), Decimal("1.07510")]
    assert all(c.open == c.high == c.low == c.close and c.volume == 0 for c in out)
    with pytest.raises(UnsupportedTimeframe):
        await p.get_candles(EUR, "1h", start, end)
    q = await p.get_quote(EUR)
    assert q.last == Decimal("1.07510") and q.prev_close == Decimal("1.07346")
    assert q.source == "ecb_reference"


async def test_coinbase_quotes_from_the_live_feed_and_caches_stats():
    import time as _time

    from app.market import tickbars
    calls = []

    def handler(req):
        calls.append(req.url.path)
        if req.url.path.endswith("/ticker"):
            return httpx.Response(200, json={"price": "1", "bid": "0.9", "ask": "1.1", "time": "2026-11-23T12:00:00Z"})
        return httpx.Response(200, json={"open": "0.5"})

    p = coinbase(handler)
    tickbars.LATEST["BTC-USD"] = (_time.monotonic(), {"type": "ticker", "product_id": "BTC-USD", "price": "91000.5",
                                                      "best_bid": "91000.1", "best_ask": "91000.9", "open_24h": "90000",
                                                      "time": "2026-11-23T12:00:00.5Z"})
    try:
        q = await p.get_quote(BTC)
        assert calls == [] and q.last == Decimal("91000.5") and q.bid == Decimal("91000.1") and q.prev_close == 90000
        tickbars.LATEST["BTC-USD"] = (_time.monotonic() - 60, tickbars.LATEST["BTC-USD"][1])   # feed went quiet
        await p.get_quote(BTC)
        await p.get_quote(BTC)
        assert calls.count("/products/BTC-USD/stats") == 1 and calls.count("/products/BTC-USD/ticker") == 2
    finally:
        tickbars.LATEST.clear()


async def test_live_fx_rates_quotes_daily_history_and_scaled_intraday():
    from app.market.providers.livefx import LiveFxProvider
    rate_calls = []

    def rates(req):
        rate_calls.append(1)
        return httpx.Response(200, json={"data": {"currency": "USD", "rates": {"EUR": "0.9", "GBP": "0.8", "JPY": "150.25"}}})

    def ecb(req):
        return httpx.Response(200, json={"rates": {"2026-11-19": {"USD": 1.1}, "2026-11-20": {"USD": 1.105}}})

    p = LiveFxProvider("https://rates.test/v2/exchange-rates", frankfurter(ecb),
                       client=httpx.AsyncClient(transport=httpx.MockTransport(rates)))
    q = await p.get_quote(EUR)
    assert q.source == "coinbase_rates" and q.last == Decimal("1.11111") and q.bid < q.last < q.ask
    assert q.prev_close == Decimal("1.10500")
    await p.get_quote(EUR)
    assert len(rate_calls) == 1                         # one cached request serves every pair
    start = datetime.now(UTC) - timedelta(hours=3)
    rows = await p.get_candles(EUR, "5m", start, datetime.now(UTC))
    assert len(rows) > 30 and abs(rows[-1].close - Decimal("1.11111")) < Decimal("0.01")   # ends near the live rate
    assert p.source_for("5m") == "synthetic" and p.source_for("1d") == "ecb_reference"
    daily = await p.get_candles(EUR, "1d", datetime(2026, 11, 19, tzinfo=UTC), datetime(2026, 11, 21, tzinfo=UTC))
    assert [c.close for c in daily] == [Decimal("1.10000"), Decimal("1.10500")]
