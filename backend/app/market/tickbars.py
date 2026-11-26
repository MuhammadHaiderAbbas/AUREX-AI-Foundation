"""30-second bars for live crypto, built from Coinbase's public trade stream.

Coinbase's REST candles start at 1 minute and its trade history is far too dense to backfill
30-second bars (BTC-USD prints about 1,000 trades every 20 seconds). So the server records them:
one WebSocket connection to the public ticker channel for every Coinbase instrument, folded into
30-second OHLC buckets and upserted into market_candles (timeframe "30s") as each bucket closes.

Only the worker leader writes. History starts when the server starts and then accumulates; the
binary bot needs about 140 minutes of it (80 warm-up bars + 200 usable) before it will judge a
30-second edge, and it only uses the latest unbroken run of bars (a disconnect leaves a gap).
"""

import asyncio
import json
import logging
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert

from app.core.config import get_settings
from app.database.session import SessionLocal
from app.models import Instrument, MarketCandle

log = logging.getLogger("aurex.tickbars")
BAR_SECONDS = 30
TIMEFRAME = "30s"
SOURCE = "coinbase_ws"


@dataclass
class Bar:
    start: int                     # epoch seconds, aligned to BAR_SECONDS
    open: Decimal
    high: Decimal
    low: Decimal
    close: Decimal
    volume: Decimal


class BarBuilder:
    """Pure: fold (product, time, price, size) samples into closed 30-second bars."""

    def __init__(self, seconds: int = BAR_SECONDS, skip_first: bool = True):
        self.seconds = seconds
        self.skip_first = skip_first         # the first bucket after (re)connecting started mid-way: drop it
        self.current: dict[str, Bar] = {}
        self.partial: set[str] = set()

    def _emit(self, product: str, bar: Bar) -> list[tuple[str, Bar]]:
        if product in self.partial:
            self.partial.discard(product)
            return []
        return [(product, bar)]

    def add(self, product: str, at: datetime, price: Decimal, size: Decimal = Decimal(0)) -> list[tuple[str, Bar]]:
        start = int(at.timestamp()) // self.seconds * self.seconds
        bar = self.current.get(product)
        closed: list[tuple[str, Bar]] = []
        if bar is not None and start < bar.start:
            return closed                                      # late, out-of-order print: ignore
        if bar is not None and start > bar.start:
            closed += self._emit(product, bar)
            # Quiet buckets in between (no trades) repeat the last close, so the series stays even.
            for s in range(bar.start + self.seconds, start, self.seconds):
                closed.append((product, Bar(s, bar.close, bar.close, bar.close, bar.close, Decimal(0))))
            bar = None
        if bar is None:
            if self.skip_first and product not in self.current:
                self.partial.add(product)
            self.current[product] = Bar(start, price, price, price, price, size)
        else:
            bar.high, bar.low, bar.close = max(bar.high, price), min(bar.low, price), price
            bar.volume += size
        return closed

    def flush_before(self, now: datetime) -> list[tuple[str, Bar]]:
        """Close buckets whose window has ended even if no later trade arrived."""
        cut = int(now.timestamp()) // self.seconds * self.seconds
        out = []
        for product, bar in list(self.current.items()):
            if bar.start + self.seconds <= cut:
                out += self._emit(product, bar)
                # carry the price into the open bucket so a quiet market keeps producing bars
                self.current[product] = Bar(cut, bar.close, bar.close, bar.close, bar.close, Decimal(0))
                for s in range(bar.start + self.seconds, cut, self.seconds):
                    out.append((product, Bar(s, bar.close, bar.close, bar.close, bar.close, Decimal(0))))
        return out

    def reset(self) -> None:
        """After a disconnect: drop half-built bars rather than stitch across the gap."""
        self.current.clear()
        self.partial.clear()


# Latest ticker per product from the open connection: Coinbase quotes are served from here while fresh,
# so revaluing positions every second does not hit the REST API (public limit ~10 requests/second).
LATEST: dict[str, tuple[float, dict]] = {}


def latest_ticker(product: str, max_age: float = 30.0) -> dict | None:
    hit = LATEST.get(product)
    return hit[1] if hit and time.monotonic() - hit[0] <= max_age else None


def parse_ticker(msg: dict) -> tuple[str, datetime, Decimal, Decimal] | None:
    if msg.get("type") != "ticker" or not msg.get("product_id") or not msg.get("time") or not msg.get("price"):
        return None
    try:
        at = datetime.fromisoformat(msg["time"].replace("Z", "+00:00"))
        return msg["product_id"], at, Decimal(msg["price"]), Decimal(msg.get("last_size") or 0)
    except (ValueError, ArithmeticError):
        return None


async def store(bars: list[tuple[str, Bar]], ids: dict[str, object]) -> int:
    rows = [{"instrument_id": ids[p], "timeframe": TIMEFRAME, "open_time": datetime.fromtimestamp(b.start, UTC),
             "open": b.open, "high": b.high, "low": b.low, "close": b.close, "volume": b.volume, "source": SOURCE}
            for p, b in bars if p in ids]
    if not rows:
        return 0
    async with SessionLocal() as db:
        stmt = insert(MarketCandle).values(rows)
        stmt = stmt.on_conflict_do_update(
            index_elements=["instrument_id", "timeframe", "open_time"],
            set_={k: stmt.excluded[k] for k in ("open", "high", "low", "close", "volume", "source")}
            | {"ingested_at": func.now()})
        await db.execute(stmt)
        await db.commit()
    return len(rows)


async def run(is_leader: Callable[[], bool]) -> None:
    """Keep a Coinbase ticker connection open and record 30-second bars (leader only)."""
    from websockets.asyncio.client import connect

    s = get_settings()
    builder = BarBuilder()
    backoff = 1.0
    while True:
        if s.market_data_mode != "live" or not is_leader():
            builder.reset()
            await asyncio.sleep(5)
            continue
        async with SessionLocal() as db:
            insts = list(await db.scalars(select(Instrument).where(Instrument.data_provider == "coinbase",
                                                                   Instrument.is_active.is_(True))))
        ids = {i.provider_symbol: i.id for i in insts}
        if not ids:
            await asyncio.sleep(60)
            continue
        try:
            async with connect(s.coinbase_ws_url, open_timeout=10, ping_interval=20, max_size=2**20) as ws:
                await ws.send(json.dumps({"type": "subscribe", "product_ids": sorted(ids), "channels": ["ticker"]}))
                backoff = 1.0
                log.info("tick bars: recording %d Coinbase products", len(ids))
                while is_leader():
                    try:
                        raw = await asyncio.wait_for(ws.recv(), timeout=5)
                    except TimeoutError:
                        raw = None
                    closed = builder.flush_before(datetime.now(UTC))
                    if raw is not None:
                        msg = json.loads(raw)
                        t = parse_ticker(msg)
                        if t:
                            LATEST[t[0]] = (time.monotonic(), msg)
                            closed += builder.add(*t)
                    if closed:
                        await store(closed, ids)
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001 - network drops are expected; reconnect with backoff
            log.warning("tick bars: connection lost (%s); retrying in %.0fs", e.__class__.__name__, backoff)
        builder.reset()
        await asyncio.sleep(backoff)
        backoff = min(backoff * 2, 60.0)
