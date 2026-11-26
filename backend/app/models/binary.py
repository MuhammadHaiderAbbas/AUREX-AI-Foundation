"""Binary option contracts (paper only, Phase 13)."""

import uuid
from datetime import datetime
from decimal import Decimal

from sqlalchemy import (
    JSON,
    Boolean,
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
        CheckConstraint("source IN ('manual','bot')", name="source_valid"),
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
    source: Mapped[str] = mapped_column(String(6), nullable=False, default="manual", server_default="manual")
    signal: Mapped[dict | None] = mapped_column(JSON)          # the bot's evidence when it opened the contract


class BinaryBot(Timestamps, Base):
    """The one-button binary bot for a paper account. It trades only with a validated edge."""

    __tablename__ = "binary_bots"
    __table_args__ = (
        CheckConstraint("status IN ('STOPPED','RUNNING','PAUSED')", name="status_valid"),
        CheckConstraint("stake_pct > 0 AND stake_pct <= 5", name="stake_range"),
        CheckConstraint("min_confidence >= 0.5 AND min_confidence < 1", name="confidence_range"),
        CheckConstraint("edge_margin >= 0 AND edge_margin <= 0.2", name="edge_margin_range"),
        CheckConstraint("guard_min_contracts BETWEEN 5 AND 500", name="guard_range"),
    )

    account_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("trading_accounts.id", ondelete="CASCADE"),
                                                  primary_key=True)
    status: Mapped[str] = mapped_column(String(8), nullable=False, default="STOPPED")
    symbols: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)
    expiry_seconds: Mapped[int] = mapped_column(Integer, nullable=False, default=300)
    stake_pct: Mapped[float] = mapped_column(Float, nullable=False, default=1.0)
    min_confidence: Mapped[float] = mapped_column(Float, nullable=False, default=0.6)
    edge_margin: Mapped[float] = mapped_column(Float, nullable=False, default=0.02)
    guard_min_contracts: Mapped[int] = mapped_column(Integer, nullable=False, default=20)
    allow_synthetic: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_cycle_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    paused_reason: Mapped[str | None] = mapped_column(Text)
