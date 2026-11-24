"""Binary option contracts (paper only, Phase 13)."""

import uuid
from datetime import datetime
from decimal import Decimal

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    Uuid,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.database.base import Base, Timestamps, UUIDPk

MONEY = Numeric(28, 8)
PRICE = Numeric(28, 10)


class BinaryStatus:
    OPEN = "OPEN"
    WON = "WON"
    LOST = "LOST"
    TIE = "TIE"
    VOID = "VOID"


class BinaryContract(UUIDPk, Timestamps, Base):
    """A fixed-payout HIGHER/LOWER contract on an instrument's price at expiry."""

    __tablename__ = "binary_contracts"
    __table_args__ = (
        CheckConstraint("direction IN ('HIGHER','LOWER')", name="direction_valid"),
        CheckConstraint("status IN ('OPEN','WON','LOST','TIE','VOID')", name="status_valid"),
        CheckConstraint("stake > 0", name="stake_positive"),
        CheckConstraint("payout_rate > 0 AND payout_rate < 1", name="payout_range"),
        CheckConstraint("expires_at > opened_at", name="expiry_after_open"),
        CheckConstraint("status = 'OPEN' OR settled_at IS NOT NULL", name="settled_has_time"),
        Index("ix_binary_open_expiry", "expires_at", postgresql_where=text("status = 'OPEN'")),
        UniqueConstraint("account_id", "client_id", name="uq_binary_client_id"),
    )

    account_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("trading_accounts.id", ondelete="RESTRICT"),
                                                  nullable=False, index=True)
    user_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("users.id", ondelete="RESTRICT"), nullable=False)
    instrument_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("instruments.id"), nullable=False)
    symbol: Mapped[str] = mapped_column(String(32), nullable=False)
    direction: Mapped[str] = mapped_column(String(6), nullable=False)
    stake: Mapped[Decimal] = mapped_column(MONEY, nullable=False)              # account currency
    currency: Mapped[str] = mapped_column(String(3), nullable=False)
    payout_rate: Mapped[float] = mapped_column(Float, nullable=False)
    strike: Mapped[Decimal] = mapped_column(PRICE, nullable=False)             # instrument quote currency
    expiry_seconds: Mapped[int] = mapped_column(Integer, nullable=False)
    opened_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    status: Mapped[str] = mapped_column(String(5), nullable=False, default=BinaryStatus.OPEN)
    settle_price: Mapped[Decimal | None] = mapped_column(PRICE)
    settle_price_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    settled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    returned: Mapped[Decimal | None] = mapped_column(MONEY)                     # cash paid back at settlement
    pnl: Mapped[Decimal | None] = mapped_column(MONEY)
    void_reason: Mapped[str | None] = mapped_column(Text)
    open_txn_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    settle_txn_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    client_id: Mapped[str | None] = mapped_column(String(64))
