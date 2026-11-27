"""Price alerts: create, list, cancel, and the worker check that triggers them on live quotes."""

from datetime import UTC, datetime
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import BusinessRuleViolation, NotFound
from app.market.service import MarketService, ProviderUnavailable
from app.models import AlertStatus, PriceAlert, User

MAX_ACTIVE = 50


async def create(db: AsyncSession, user: User, symbol: str, direction: str, price: Decimal, note: str | None) -> PriceAlert:
    inst = await MarketService(db).get(symbol)
    active = await db.scalar(select(func.count()).select_from(PriceAlert).where(
        PriceAlert.user_id == user.id, PriceAlert.status == AlertStatus.ACTIVE))
    if (active or 0) >= MAX_ACTIVE:
        raise BusinessRuleViolation(f"You can have at most {MAX_ACTIVE} active alerts")
    a = PriceAlert(user_id=user.id, symbol=inst.symbol, direction=direction, price=price, note=note or None, status=AlertStatus.ACTIVE)
    db.add(a)
    await db.flush()
    return a


async def owned(db: AsyncSession, user: User, alert_id) -> PriceAlert:
    a = await db.get(PriceAlert, alert_id)
    if a is None or a.user_id != user.id:
        raise NotFound("Alert not found")
    return a


def crossed(direction: str, level: Decimal, last: Decimal) -> bool:
    return last >= level if direction == "ABOVE" else last <= level


async def check_all(db: AsyncSession) -> int:
    """Trigger every active alert whose instrument has crossed its level (fresh quotes only)."""
    alerts = list(await db.scalars(select(PriceAlert).where(PriceAlert.status == AlertStatus.ACTIVE)
                                   .with_for_update(skip_locked=True)))
    if not alerts:
        return 0
    svc, fired, last_by_symbol = MarketService(db), 0, {}
    for a in alerts:
        if a.symbol not in last_by_symbol:
            try:
                q = await svc.quote(await svc.get(a.symbol))
                last_by_symbol[a.symbol] = None if q.stale or not q.market_open else q.last
            except ProviderUnavailable:
                last_by_symbol[a.symbol] = None
        last = last_by_symbol[a.symbol]
        if last is not None and crossed(a.direction, a.price, last):
            a.status, a.triggered_at, a.triggered_price = AlertStatus.TRIGGERED, datetime.now(UTC), last
            fired += 1
    await db.flush()
    return fired
