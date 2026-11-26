"""Alpaca market-data adapter (mocked HTTP) and the no-key fallback to simulated prices."""

from datetime import UTC, datetime
from decimal import Decimal

import httpx
import pytest

from app.core.config import get_settings
from app.market import service as msvc
from app.market.providers.alpaca import AlpacaProvider
from app.market.types import InstrumentRef, ProviderError

REF = InstrumentRef(symbol="AAPL", asset_class="STOCK", market="US_EQUITY", provider_symbol="AAPL", price_decimals=2,
                    base_price=Decimal("230"))


def provider(handler):
    client = httpx.AsyncClient(base_url="https://data.alpaca.markets", transport=httpx.MockTransport(handler),
                               headers={"APCA-API-KEY-ID": "k", "APCA-API-SECRET-KEY": "s"})
    return AlpacaProvider("k", "s", client=client)


async def test_snapshot_quote():
    def handler(req: httpx.Request):
        assert req.url.path == "/v2/stocks/AAPL/snapshot" and req.url.params["feed"] == "iex"
        assert req.headers["APCA-API-KEY-ID"] == "k"
        return httpx.Response(200, json={
            "latestTrade": {"t": "2026-11-26T15:30:00Z", "p": 355.58},
            "latestQuote": {"t": "2026-11-26T15:30:01Z", "bp": 355.55, "ap": 355.60},
            "prevDailyBar": {"c": 354.07}})
    q = await provider(handler).get_quote(REF)
    assert (q.last, q.bid, q.ask, q.prev_close) == (Decimal("355.58"), Decimal("355.55"), Decimal("355.6"), Decimal("354.07"))
    assert q.as_of == datetime(2026, 11, 26, 15, 30, 1, tzinfo=UTC) and q.source == "alpaca"


async def test_quote_without_a_book_uses_last_trade():
    def handler(req):
        return httpx.Response(200, json={"latestTrade": {"t": "2026-11-26T21:00:00Z", "p": 100}, "latestQuote": {"bp": 0, "ap": 0}})
    q = await provider(handler).get_quote(REF)
    assert q.bid == q.ask == q.last == Decimal("100") and q.prev_close is None


async def test_bars_paginate_and_keep_completed_candles():
    pages = {
        None: {"bars": [{"t": "2026-11-26T14:30:00Z", "o": 1, "h": 2, "l": 0.5, "c": 1.5, "v": 10}], "next_page_token": "p2"},
        "p2": {"bars": [{"t": "2026-11-26T14:31:00Z", "o": 1.5, "h": 2, "l": 1, "c": 1.8, "v": 5},
                        {"t": "2026-11-26T14:32:00Z", "o": 1.8, "h": 1.9, "l": 1.7, "c": 1.75, "v": 3}], "next_page_token": None},
    }

    def handler(req):
        assert req.url.params["timeframe"] == "1Min"
        return httpx.Response(200, json=pages[req.url.params.get("page_token")])
    start, end = datetime(2026, 11, 26, 14, 30, tzinfo=UTC), datetime(2026, 11, 26, 14, 32, 30, tzinfo=UTC)
    bars = await provider(handler).get_candles(REF, "1m", start, end)
    assert [b.open_time.minute for b in bars] == [30, 31]          # 14:32 is still forming
    assert bars[1].close == Decimal("1.8")


async def test_errors_are_explained():
    with pytest.raises(ProviderError, match="rejected the API key"):
        await provider(lambda r: httpx.Response(403, json={})).get_quote(REF)
    with pytest.raises(ProviderError, match="rate limit"):
        await provider(lambda r: httpx.Response(429, json={})).get_quote(REF)
    with pytest.raises(ProviderError, match="unsupported timeframe"):
        await provider(lambda r: httpx.Response(200, json={})).get_candles(REF, "2h", datetime.now(UTC), datetime.now(UTC))


def test_without_a_key_us_stocks_stay_simulated(monkeypatch):
    class Inst:
        data_provider = "alpaca"
    monkeypatch.setenv("AUREX_MARKET_DATA_MODE", "live")
    monkeypatch.delenv("AUREX_ALPACA_KEY_ID", raising=False)
    get_settings.cache_clear()
    msvc.set_provider("alpaca", None)
    try:
        assert msvc.provider_for(Inst()).name == "synthetic"
        monkeypatch.setenv("AUREX_ALPACA_KEY_ID", "k")
        monkeypatch.setenv("AUREX_ALPACA_SECRET_KEY", "s")
        get_settings.cache_clear()
        assert msvc.provider_for(Inst()).name == "alpaca"
    finally:
        msvc.set_provider("alpaca", None)
        get_settings.cache_clear()
