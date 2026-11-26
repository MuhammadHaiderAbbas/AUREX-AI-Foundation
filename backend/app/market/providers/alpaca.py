"""Alpaca Market Data: real US stock and ETF prices (requires a free Alpaca account key).

Docs: GET /v2/stocks/{symbol}/bars?timeframe=1Min|5Min|15Min|1Hour|4Hour|1Day&start&end&feed=iex
        -> {"bars": [{"t","o","h","l","c","v"}, ...], "next_page_token": str | null}
      GET /v2/stocks/{symbol}/snapshot?feed=iex
        -> {"latestTrade": {"t","p"}, "latestQuote": {"t","bp","ap"}, "prevDailyBar": {"c"}, ...}
The free plan's IEX feed is real time. The key ID and secret are server-side secrets
(AUREX_ALPACA_KEY_ID_FILE / AUREX_ALPACA_SECRET_KEY_FILE); they never reach the browser.
"""

from datetime import UTC, datetime, timedelta
from decimal import Decimal

import httpx

from app.market.types import TIMEFRAMES, Candle, InstrumentRef, ProviderError, RawQuote

TF = {"1m": "1Min", "5m": "5Min", "15m": "15Min", "1h": "1Hour", "4h": "4Hour", "1d": "1Day"}


def _ts(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


class AlpacaProvider:
    name = "alpaca"

    def __init__(self, key_id: str, secret_key: str, base_url: str = "https://data.alpaca.markets",
                 feed: str = "iex", client: httpx.AsyncClient | None = None, timeout: float = 10.0):
        self.feed = feed
        self._client = client or httpx.AsyncClient(base_url=base_url, timeout=timeout, headers={
            "APCA-API-KEY-ID": key_id, "APCA-API-SECRET-KEY": secret_key, "User-Agent": "aurex-ai/0.2"})

    async def _get(self, path: str, params: dict | None = None) -> dict:
        try:
            r = await self._client.get(path, params=params)
        except httpx.HTTPError as e:
            raise ProviderError(f"alpaca unreachable: {e.__class__.__name__}") from e
        if r.status_code in (401, 403):
            raise ProviderError("alpaca rejected the API key (check AUREX_ALPACA_KEY_ID / SECRET)")
        if r.status_code == 429:
            raise ProviderError("alpaca rate limit reached")
        if r.status_code != 200:
            raise ProviderError(f"alpaca {path} -> HTTP {r.status_code}")
        return r.json()

    async def get_candles(self, inst: InstrumentRef, timeframe: str, start: datetime, end: datetime) -> list[Candle]:
        if timeframe not in TF:
            raise ProviderError(f"unsupported timeframe {timeframe}")
        end = min(end, datetime.now(UTC))
        step = timedelta(seconds=TIMEFRAMES[timeframe])
        rows: list[Candle] = []
        token: str | None = None
        for _ in range(50):                                   # pages of up to 10,000 bars
            params = {"timeframe": TF[timeframe], "start": start.isoformat(), "end": end.isoformat(), "limit": 10000,
                      "feed": self.feed, "adjustment": "raw", "sort": "asc"}
            if token:
                params["page_token"] = token
            data = await self._get(f"/v2/stocks/{inst.provider_symbol}/bars", params)
            for b in data.get("bars") or []:
                try:
                    ot = _ts(b["t"])
                    if start <= ot and ot + step <= end:          # completed candles only
                        rows.append(Candle(ot, Decimal(str(b["o"])), Decimal(str(b["h"])), Decimal(str(b["l"])),
                                           Decimal(str(b["c"])), Decimal(str(b["v"]))))
                except (KeyError, ValueError, ArithmeticError) as e:
                    raise ProviderError("alpaca bars: unexpected payload") from e
            token = data.get("next_page_token")
            if not token:
                break
        uniq = {c.open_time: c for c in rows}
        return [uniq[k] for k in sorted(uniq)]

    async def get_quote(self, inst: InstrumentRef) -> RawQuote:
        s = await self._get(f"/v2/stocks/{inst.provider_symbol}/snapshot", {"feed": self.feed})
        try:
            trade, quote = s["latestTrade"], s.get("latestQuote") or {}
            last = Decimal(str(trade["p"]))
            bid = Decimal(str(quote.get("bp") or 0))
            ask = Decimal(str(quote.get("ap") or 0))
            if bid <= 0 or ask <= 0 or ask < bid or not (bid * Decimal("0.9") < last < ask * Decimal("1.1")):
                bid = ask = last          # no usable book (e.g. after hours): quote the last trade
            prev = (s.get("prevDailyBar") or {}).get("c")
            as_of = max(_ts(trade["t"]), _ts(quote["t"])) if quote.get("t") else _ts(trade["t"])
            return RawQuote(last=last, bid=bid, ask=ask, prev_close=Decimal(str(prev)) if prev else None,
                            as_of=as_of, source=self.name)
        except (KeyError, ValueError, ArithmeticError) as e:
            raise ProviderError("alpaca snapshot: unexpected payload") from e
