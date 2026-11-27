"""Order-book liquidity for futures fills.

Market orders walk the book level by level (asks for a buy, bids for a sell), so a large order
gets a worse average price than the top of the book, and an order bigger than the book's depth is
refused. Crypto uses Coinbase's live level-2 book (cached for 2 s). Elsewhere, or when that fails,
a synthetic book is built around the current quote and labelled as such.
"""

import time
from dataclasses import dataclass
from decimal import Decimal

from app.market.service import MarketService, provider_for, ref
from app.market.types import ProviderError
from app.models import Instrument

_cache: dict[str, tuple[float, dict]] = {}
SYNTH_LEVELS = 40
SYNTH_STEP = Decimal("0.0002")            # 2 bps between levels
SYNTH_TOP_NOTIONAL = Decimal("25000")     # quote-currency depth at the best level


@dataclass
class Fill:
    quantity: Decimal
    avg_price: Decimal
    best_price: Decimal
    worst_price: Decimal
    levels: int
    slippage_bps: float


def synthetic_book(bid: Decimal, ask: Decimal) -> dict:
    mid = (bid + ask) / 2
    bids, asks = [], []
    for i in range(SYNTH_LEVELS):
        size = (SYNTH_TOP_NOTIONAL * (1 + Decimal(i) * Decimal("0.35")) / mid).quantize(Decimal("0.00000001"))
        bids.append((bid * (1 - SYNTH_STEP * i), size))
        asks.append((ask * (1 + SYNTH_STEP * i), size))
    return {"bids": bids, "asks": asks, "source": "synthetic"}


async def book(svc: MarketService, inst: Instrument) -> dict:
    hit = _cache.get(inst.symbol)
    if hit and time.monotonic() - hit[0] < 2:
        return hit[1]
    p = provider_for(inst)
    data = None
    if hasattr(p, "get_book"):
        try:
            data = {**await p.get_book(ref(inst)), "source": p.name}
        except ProviderError:
            data = None
    if data is None:
        q = await svc.quote(inst)
        data = synthetic_book(q.bid, q.ask)
    _cache[inst.symbol] = (time.monotonic(), data)
    return data


def walk(levels: list[tuple[Decimal, Decimal]], quantity: Decimal) -> Fill | None:
    """Fill `quantity` against the book side; None when the book is not deep enough."""
    left, cost, used, worst = quantity, Decimal(0), 0, levels[0][0] if levels else Decimal(0)
    for price, size in levels:
        take = min(left, size)
        cost += take * price
        left -= take
        used += 1
        worst = price
        if left <= 0:
            break
    if left > 0 or not levels:
        return None
    avg = cost / quantity
    best = levels[0][0]
    return Fill(quantity, avg, best, worst, used, float(abs(avg - best) / best * 10000))


def clear_cache() -> None:
    _cache.clear()
