"""Live Coinbase ticker feed for server-side quotes.

The worker leader keeps one WebSocket connection to Coinbase's public ticker channel for every
Coinbase instrument and remembers the latest ticker per product. CoinbaseProvider.get_quote serves
quotes from here while they are fresh, so revaluing positions every second does not hit the REST
API (public limit about 10 requests per second). REST is the fallback when a product is quiet.

(Until ADR-045 this module also recorded 30-second bars for a 30-second binary expiry; that expiry
was removed because 30-second moves are mostly noise.)
"""

import asyncio
import json
import logging
import time
from collections.abc import Callable
from datetime import datetime
from decimal import Decimal

from sqlalchemy import select

from app.core.config import get_settings
from app.database.session import SessionLocal
from app.models import Instrument

log = logging.getLogger("aurex.tickbars")

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


async def run(is_leader: Callable[[], bool]) -> None:
    """Keep a Coinbase ticker connection open and remember the latest ticker (leader only)."""
    from websockets.asyncio.client import connect

    s = get_settings()
    backoff = 1.0
    while True:
        if s.market_data_mode != "live" or not is_leader():
            await asyncio.sleep(5)
            continue
        async with SessionLocal() as db:
            products = sorted({i.provider_symbol for i in await db.scalars(
                select(Instrument).where(Instrument.data_provider == "coinbase", Instrument.is_active.is_(True)))})
        if not products:
            await asyncio.sleep(60)
            continue
        try:
            async with connect(s.coinbase_ws_url, open_timeout=10, ping_interval=20, max_size=2**20) as ws:
                await ws.send(json.dumps({"type": "subscribe", "product_ids": products, "channels": ["ticker"]}))
                backoff = 1.0
                log.info("live ticker: streaming %d Coinbase products", len(products))
                while is_leader():
                    try:
                        raw = await asyncio.wait_for(ws.recv(), timeout=5)
                    except TimeoutError:
                        continue
                    msg = json.loads(raw)
                    if parse_ticker(msg):
                        LATEST[msg["product_id"]] = (time.monotonic(), msg)
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001 - network drops are expected; reconnect with backoff
            log.warning("live ticker: connection lost (%s); retrying in %.0fs", e.__class__.__name__, backoff)
        await asyncio.sleep(backoff)
        backoff = min(backoff * 2, 60.0)
