"""Coinbase Exchange public market data (no API key; read-only).

Docs: GET /products/{id}/candles  -> [[time, low, high, open, close, volume], ...] newest first,
      max 300 rows, granularity in {60, 300, 900, 3600, 21600, 86400}.
      GET /products/{id}/ticker   -> {"price","bid","ask","time",...}
      GET /products/{id}/stats    -> {"open","high","low","last","volume"} (24h)
4h candles are not offered upstream and are aggregated from 1h.
"""

from datetime import UTC, datetime, timedelta
from decimal import Decimal

import httpx

from app.market.types import TIMEFRAMES, Candle, InstrumentRef, ProviderError, RawQuote

NATIVE = {"1m": 60, "5m": 300, "15m": 900, "1h": 3600, "1d": 86400}
MAX_ROWS = 300


class CoinbaseProvider:
    name = "coinbase"

    def __init__(self, base_url: str = "https://api.exchange.coinbase.com",
                 client: httpx.AsyncClient | None = None, timeout: float = 10.0):
        self._client = client or httpx.AsyncClient(
            base_url=base_url, timeout=timeout, headers={"User-Agent": "aurex-ai/0.2"})

    async def _get(self, path: str, params: dict | None = None):
        try:
            r = await self._client.get(path, params=params)
        except httpx.HTTPError as e:
            raise ProviderError(f"coinbase unreachable: {e.__class__.__name__}") from e
        if r.status_code != 200:
            raise ProviderError(f"coinbase {path} -> HTTP {r.status_code}")
        return r.json()

    async def _native(self, product: str, gran: int, start: datetime, end: datetime):
        rows: list[Candle] = []
        cursor = start
        while cursor < end:
            chunk_end = min(end, cursor + timedelta(seconds=gran * MAX_ROWS))
            data = await self._get(f"/products/{product}/candles", {
                "granularity": gran, "start": cursor.isoformat(), "end": chunk_end.isoformat()})
            if not isinstance(data, list):
                raise ProviderError("coinbase candles: unexpected payload")
            for t, low, high, op, close, vol in data:
                ot = datetime.fromtimestamp(int(t), UTC)
                if start <= ot and ot + timedelta(seconds=gran) <= end:
                    rows.append(Candle(ot, Decimal(str(op)), Decimal(str(high)),
                                       Decimal(str(low)), Decimal(str(close)), Decimal(str(vol))))
            cursor = chunk_end
        uniq = {c.open_time: c for c in rows}
        return [uniq[k] for k in sorted(uniq)]

    async def get_candles(self, inst: InstrumentRef, timeframe: str, start: datetime,
                          end: datetime) -> list[Candle]:
        end = min(end, datetime.now(UTC))
        if timeframe in NATIVE:
            return await self._native(inst.provider_symbol, NATIVE[timeframe], start, end)
        if timeframe == "4h":
            hourly = await self._native(inst.provider_symbol, 3600, start, end)
            return aggregate(hourly, TIMEFRAMES["4h"])
        raise ProviderError(f"unsupported timeframe {timeframe}")

    async def get_quote(self, inst: InstrumentRef) -> RawQuote:
        t = await self._get(f"/products/{inst.provider_symbol}/ticker")
        stats = await self._get(f"/products/{inst.provider_symbol}/stats")
        try:
            return RawQuote(
                last=Decimal(t["price"]), bid=Decimal(t["bid"]), ask=Decimal(t["ask"]),
                prev_close=Decimal(stats["open"]) if stats.get("open") else None,
                as_of=datetime.fromisoformat(t["time"].replace("Z", "+00:00")),
                source=self.name,
            )
        except (KeyError, ValueError, ArithmeticError) as e:
            raise ProviderError("coinbase ticker: unexpected payload") from e


def aggregate(candles: list[Candle], seconds: int) -> list[Candle]:
    """Roll up complete lower-timeframe candles into `seconds` buckets (UTC aligned)."""
    buckets: dict[int, list[Candle]] = {}
    for c in candles:
        key = int(c.open_time.timestamp()) // seconds * seconds
        buckets.setdefault(key, []).append(c)
    out = []
    for key in sorted(buckets):
        group = buckets[key]
        out.append(Candle(datetime.fromtimestamp(key, UTC), group[0].open,
                          max(c.high for c in group), min(c.low for c in group),
                          group[-1].close, sum((c.volume for c in group), Decimal(0))))
    return out
