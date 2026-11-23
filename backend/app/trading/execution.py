"""Pure execution model for paper fills on the live quote.

Prices come from the quote's bid/ask (so the spread is paid), plus the asset class's base
slippage from the Phase 7 cost model, plus its commission. Limit orders never fill worse
than their limit; stop orders become market orders once triggered and can fill worse.
"""

from dataclasses import dataclass
from decimal import Decimal

from app.backtest.engine import DEFAULT_COSTS


@dataclass(frozen=True)
class Fill:
    price: Decimal       # executed price (quote currency)
    reference: Decimal   # bid or ask at the time of the fill


def slippage(asset_class: str) -> Decimal:
    return Decimal(str(DEFAULT_COSTS[asset_class].slippage_bps)) / Decimal(10_000)


def fee_rate(asset_class: str) -> Decimal:
    return Decimal(str(DEFAULT_COSTS[asset_class].fee_bps)) / Decimal(10_000)


def match(side: str, order_type: str, bid: Decimal, ask: Decimal, limit: Decimal | None, stop: Decimal | None,
          slip: Decimal) -> Fill | None:
    """Returns a fill if the order is executable against this quote, else None."""
    if side == "BUY":
        worst = ask * (1 + slip)
        if order_type == "MARKET":
            return Fill(worst, ask)
        if order_type == "LIMIT" and limit is not None and ask <= limit:
            return Fill(min(limit, worst), ask)
        if order_type == "STOP" and stop is not None and ask >= stop:
            return Fill(worst, ask)
        return None
    worst = bid * (1 - slip)
    if order_type == "MARKET":
        return Fill(worst, bid)
    if order_type == "LIMIT" and limit is not None and bid >= limit:
        return Fill(max(limit, worst), bid)
    if order_type == "STOP" and stop is not None and bid <= stop:
        return Fill(worst, bid)
    return None
