"""Forex on the server: live rates from Coinbase, daily history from the ECB, simulated intraday.

  quotes        GET https://api.coinbase.com/v2/exchange-rates?currency=USD (public, keyless, about once a
                minute upstream; one request serves every pair and is cached for `cache_seconds`)
  1d candles    Frankfurter (ECB reference fixings), as before
  intraday      no free intraday FX history exists, so intraday candles come from the simulator scaled
                to end on the live rate, and are stored with source "synthetic" so the UI labels them

Quotes are tradable (a live rate with a small synthetic spread). This mirrors the public demo.
"""

import time
from datetime import UTC, datetime
from decimal import Decimal

import httpx

from app.market.providers.frankfurter import FrankfurterProvider
from app.market.providers.synthetic import SyntheticProvider, price_at
from app.market.types import Candle, InstrumentRef, ProviderError, RawQuote

SPREAD = Decimal("0.00002")          # ±0.002% around the mid, about a retail FX spread


class LiveFxProvider:
    name = "coinbase_rates"

    def __init__(self, rates_url: str = "https://api.coinbase.com/v2/exchange-rates",
                 ecb: FrankfurterProvider | None = None, client: httpx.AsyncClient | None = None,
                 cache_seconds: float = 20.0, timeout: float = 10.0):
        self.rates_url = rates_url
        self.ecb = ecb or FrankfurterProvider()
        self.synthetic = SyntheticProvider()
        self.cache_seconds = cache_seconds
        self._client = client or httpx.AsyncClient(timeout=timeout, headers={"User-Agent": "aurex-ai/0.2"})
        self._rates: tuple[float, datetime, dict[str, str]] | None = None
        self._prev: dict[str, tuple[float, Decimal | None]] = {}

    def source_for(self, timeframe: str) -> str:
        return self.ecb.name if timeframe == "1d" else self.synthetic.name

    async def _usd_rates(self) -> tuple[datetime, dict[str, str]]:
        if self._rates and time.monotonic() - self._rates[0] < self.cache_seconds:
            return self._rates[1], self._rates[2]
        try:
            r = await self._client.get(self.rates_url, params={"currency": "USD"})
        except httpx.HTTPError as e:
            raise ProviderError(f"coinbase rates unreachable: {e.__class__.__name__}") from e
        if r.status_code != 200:
            raise ProviderError(f"coinbase rates -> HTTP {r.status_code}")
        try:
            rates = r.json()["data"]["rates"]
        except (KeyError, ValueError) as e:
            raise ProviderError("coinbase rates: unexpected payload") from e
        self._rates = (time.monotonic(), datetime.now(UTC), rates)
        return self._rates[1], rates

    async def _mid(self, inst: InstrumentRef) -> tuple[datetime, Decimal]:
        base, quote = inst.provider_symbol.split("/")
        at, rates = await self._usd_rates()
        try:
            units = {c: Decimal(rates[c]) if c != "USD" else Decimal(1) for c in (base, quote)}  # per 1 USD
            mid = units[quote] / units[base]
        except (KeyError, ArithmeticError) as e:
            raise ProviderError(f"coinbase rates: no rate for {inst.provider_symbol}") from e
        return at, mid

    async def _prev_close(self, inst: InstrumentRef) -> Decimal | None:
        hit = self._prev.get(inst.symbol)
        if hit and time.monotonic() - hit[0] < 3600:
            return hit[1]
        try:
            prev = (await self.ecb.get_quote(inst)).last
        except ProviderError:
            prev = None
        self._prev[inst.symbol] = (time.monotonic(), prev)
        return prev

    async def get_quote(self, inst: InstrumentRef) -> RawQuote:
        at, mid = await self._mid(inst)
        q = Decimal(1).scaleb(-inst.price_decimals)
        half = max(mid * SPREAD, q)
        return RawQuote(last=mid.quantize(q), bid=(mid - half).quantize(q), ask=(mid + half).quantize(q),
                        prev_close=await self._prev_close(inst), as_of=at, source=self.name)

    async def get_candles(self, inst: InstrumentRef, timeframe: str, start: datetime, end: datetime) -> list[Candle]:
        if timeframe == "1d":
            return await self.ecb.get_candles(inst, timeframe, start, end)
        rows = self.synthetic.candles(inst, timeframe, start, end)
        try:
            _, mid = await self._mid(inst)
        except ProviderError:
            return rows                                       # no live rate: plain simulator levels
        now = datetime.now(UTC).timestamp()
        k = mid / Decimal(repr(price_at(inst.symbol, inst.asset_class, float(inst.base_price), now)))
        q = Decimal(1).scaleb(-inst.price_decimals)
        return [Candle(c.open_time, (c.open * k).quantize(q), (c.high * k).quantize(q), (c.low * k).quantize(q),
                       (c.close * k).quantize(q), c.volume) for c in rows]
