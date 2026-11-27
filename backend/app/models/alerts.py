import uuid
from datetime import datetime
from decimal import Decimal

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, Numeric, String, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from app.database.base import Base, Timestamps, UUIDPk

PRICE = Numeric(28, 10)


class AlertStatus:
    ACTIVE = "ACTIVE"
    TRIGGERED = "TRIGGERED"
    CANCELLED = "CANCELLED"


class PriceAlert(UUIDPk, Timestamps, Base):
    """Notify a trader when an instrument trades above or below a level (checked by the worker)."""

    __tablename__ = "price_alerts"
    __table_args__ = (
        CheckConstraint("direction IN ('ABOVE','BELOW')", name="direction_valid"),
        CheckConstraint("status IN ('ACTIVE','TRIGGERED','CANCELLED')", name="status_valid"),
        CheckConstraint("price > 0", name="price_positive"),
        Index("ix_price_alerts_active", "status", "symbol"),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    symbol: Mapped[str] = mapped_column(String(32), nullable=False)
    direction: Mapped[str] = mapped_column(String(5), nullable=False)
    price: Mapped[Decimal] = mapped_column(PRICE, nullable=False)
    note: Mapped[str | None] = mapped_column(String(140))
    status: Mapped[str] = mapped_column(String(9), nullable=False, default=AlertStatus.ACTIVE)
    triggered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    triggered_price: Mapped[Decimal | None] = mapped_column(PRICE)
    seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
