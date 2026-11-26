"""30-second bars recorded from the Coinbase ticker stream."""

from datetime import UTC, datetime, timedelta
from decimal import Decimal as D

from sqlalchemy import select

from app.database.session import SessionLocal
from app.market import tickbars
from app.market.service import MarketService
from app.models import Instrument, MarketCandle

T0 = datetime(2026, 1, 1, 12, 0, 0, tzinfo=UTC)


def at(s: float) -> datetime:
    return T0 + timedelta(seconds=s)


def test_first_bucket_after_connecting_is_dropped():
    b = tickbars.BarBuilder()
    b.add("BTC-USD", at(20), D("100"))                     # joined 20s into the bucket: incomplete
    assert b.add("BTC-USD", at(35), D("101")) == []
    out = b.add("BTC-USD", at(61), D("102"))
    assert [c[1].start - int(T0.timestamp()) for c in out] == [30] and out[0][1].open == 101


def test_bars_fold_trades_and_fill_quiet_buckets():
    b = tickbars.BarBuilder(skip_first=False)
    assert b.add("BTC-USD", at(1), D("100")) == []
    b.add("BTC-USD", at(10), D("105"), D("2"))
    b.add("BTC-USD", at(29.9), D("98"))
    closed = b.add("BTC-USD", at(31), D("99"))
    assert len(closed) == 1
    bar = closed[0][1]
    assert (bar.start, bar.open, bar.high, bar.low, bar.close, bar.volume) == (int(T0.timestamp()), 100, 105, 98, 98, 2)
    # nothing traded for two buckets: they repeat the last close so the series has no holes
    closed = b.add("BTC-USD", at(125), D("101"))
    assert [c[1].start - int(T0.timestamp()) for c in closed] == [30, 60, 90]
    assert closed[1][1].open == closed[1][1].close == 99
    assert b.add("BTC-USD", at(100), D("1")) == []                 # out-of-order print ignored


def test_flush_closes_buckets_without_a_new_trade():
    b = tickbars.BarBuilder(skip_first=False)
    b.add("ETH-USD", at(5), D("10"))
    assert b.flush_before(at(29)) == []
    out = b.flush_before(at(70))
    assert [c[1].start - int(T0.timestamp()) for c in out] == [0, 30]
    assert b.current["ETH-USD"].start - int(T0.timestamp()) == 60 and b.current["ETH-USD"].open == 10


def test_parse_ticker():
    m = {"type": "ticker", "product_id": "BTC-USD", "price": "60000.5", "last_size": "0.01", "time": "2026-01-01T12:00:01.5Z"}
    p, t, price, size = tickbars.parse_ticker(m)
    assert p == "BTC-USD" and price == D("60000.5") and size == D("0.01") and t.tzinfo is not None
    assert tickbars.parse_ticker({"type": "subscriptions"}) is None
    assert tickbars.parse_ticker({**m, "price": "x"}) is None


async def test_recorded_bars_are_stored_and_served_without_fetching(client, monkeypatch):
    from app.core.config import get_settings
    async with SessionLocal() as db:
        inst = await db.scalar(select(Instrument).where(Instrument.symbol == "BTC-USD"))
    now = int(datetime.now(UTC).timestamp()) // 30 * 30
    bars = [("BTC-USD", tickbars.Bar(now - 30 * k, D("100"), D("101"), D("99"), D("100.5"), D("1"))) for k in range(5, 0, -1)]
    assert await tickbars.store(bars, {"BTC-USD": inst.id}) == 5
    assert await tickbars.store(bars, {"BTC-USD": inst.id}) == 5      # idempotent upsert
    monkeypatch.setattr(get_settings(), "market_data_mode", "live")
    from app.market import service as msvc

    class NoFetch:
        name = "coinbase"

        async def get_candles(self, *a):
            raise AssertionError("30s coinbase bars must come from the recorder")
    monkeypatch.setattr(msvc, "provider_for", lambda inst: NoFetch())
    async with SessionLocal() as db:
        inst = await db.scalar(select(Instrument).where(Instrument.symbol == "BTC-USD"))
        rows = await MarketService(db).candles(inst, "30s", 100)
        assert len(rows) == 5 and rows[-1].source == "coinbase_ws"
        n = len(list(await db.scalars(select(MarketCandle).where(MarketCandle.timeframe == "30s"))))
        assert n == 5
