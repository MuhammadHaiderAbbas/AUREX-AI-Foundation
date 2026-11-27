import uuid
from datetime import UTC, datetime
from decimal import Decimal
from typing import Literal

from fastapi import APIRouter, Depends, status
from pydantic import BaseModel, Field
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app import alerts as svc
from app.api.deps import current_trader
from app.database.session import get_db
from app.models import AlertStatus, PriceAlert, User
from app.schemas.common import ORMModel

router = APIRouter(prefix="/alerts", tags=["alerts"])


class AlertCreate(BaseModel):
    symbol: str = Field(min_length=1, max_length=32)
    direction: Literal["ABOVE", "BELOW"]
    price: Decimal = Field(gt=0, max_digits=28, decimal_places=10)
    note: str | None = Field(default=None, max_length=140)


class AlertRead(ORMModel):
    id: uuid.UUID
    symbol: str
    direction: str
    price: Decimal
    note: str | None
    status: str
    created_at: datetime
    triggered_at: datetime | None
    triggered_price: Decimal | None
    seen_at: datetime | None


@router.get("", response_model=list[AlertRead])
async def list_alerts(user: User = Depends(current_trader), db: AsyncSession = Depends(get_db)):
    """Your alerts: active first, then the 50 most recently triggered or cancelled."""
    rows = await db.scalars(select(PriceAlert).where(PriceAlert.user_id == user.id)
                            .order_by((PriceAlert.status == AlertStatus.ACTIVE).desc(), PriceAlert.updated_at.desc()).limit(100))
    return list(rows)


@router.post("", response_model=AlertRead, status_code=status.HTTP_201_CREATED)
async def create_alert(data: AlertCreate, user: User = Depends(current_trader), db: AsyncSession = Depends(get_db)):
    a = await svc.create(db, user, data.symbol, data.direction, data.price, data.note)
    await db.commit()
    await db.refresh(a)
    return a


@router.delete("/{alert_id}", status_code=status.HTTP_204_NO_CONTENT)
async def cancel_alert(alert_id: uuid.UUID, user: User = Depends(current_trader), db: AsyncSession = Depends(get_db)):
    a = await svc.owned(db, user, alert_id)
    if a.status == AlertStatus.ACTIVE:
        a.status = AlertStatus.CANCELLED
    await db.commit()


@router.post("/seen", status_code=status.HTTP_204_NO_CONTENT)
async def mark_seen(user: User = Depends(current_trader), db: AsyncSession = Depends(get_db)):
    """Mark every triggered alert as seen (clears the notification badge)."""
    await db.execute(update(PriceAlert).where(PriceAlert.user_id == user.id, PriceAlert.status == AlertStatus.TRIGGERED,
                                              PriceAlert.seen_at.is_(None)).values(seen_at=datetime.now(UTC)))
    await db.commit()
