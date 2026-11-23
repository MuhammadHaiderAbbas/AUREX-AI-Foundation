from datetime import datetime
from typing import Protocol

from app.market.types import Candle, InstrumentRef, RawQuote


class MarketDataProvider(Protocol):
    """Common interface for every market-data source.

    Contract:
      * get_candles returns only *completed* candles whose open_time is in [start, end),
        oldest first, and only for periods when the instrument's market was open.
      * get_quote returns the latest price with its as-of time; staleness is judged
        by the service, not the provider.
    """

    name: str

    async def get_candles(
        self, inst: InstrumentRef, timeframe: str, start: datetime, end: datetime
    ) -> list[Candle]: ...

    async def get_quote(self, inst: InstrumentRef) -> RawQuote: ...
