import uuid
from datetime import datetime
from decimal import Decimal

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, Integer, Numeric, String, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from app.database.base import Base, Timestamps, UUIDPk

PRICE = Numeric(28, 10)
QTY = Numeric(28, 10)
MONEY = Numeric(20, 8)


class FuturesStatus:
    OPEN = "OPEN"
    CLOSED = "CLOSED"
    LIQUIDATED = "LIQUIDATED"


class FuturesPosition(UUIDPk, Timestamps, Base):
    """A paper perpetual-futures position (isolated margin). Prices are in the quote currency (USD);
    margin, fees, funding and P&L are in the account currency."""

    __tablename__ = "futures_positions"
    __table_args__ = (
        CheckConstraint("side IN ('LONG','SHORT')", name="side_valid"),
        CheckConstraint("status IN ('OPEN','CLOSED','LIQUIDATED')", name="status_valid"),
        CheckConstraint("leverage BETWEEN 1 AND 20", name="leverage_range"),
        CheckConstraint("quantity > 0 AND entry_price > 0 AND margin >= 0", name="positive"),
        Index("ix_futures_positions_open", "status", "account_id"),
    )

    account_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("trading_accounts.id", ondelete="RESTRICT"), nullable=False, index=True)
    user_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("users.id", ondelete="RESTRICT"), nullable=False)
    symbol: Mapped[str] = mapped_column(String(32), nullable=False)
    side: Mapped[str] = mapped_column(String(5), nullable=False)
    quantity: Mapped[Decimal] = mapped_column(QTY, nullable=False)
    entry_price: Mapped[Decimal] = mapped_column(PRICE, nullable=False)
    leverage: Mapped[int] = mapped_column(Integer, nullable=False)
    margin: Mapped[Decimal] = mapped_column(MONEY, nullable=False)              # account currency, current (after funding)
    margin_usd: Mapped[Decimal] = mapped_column(MONEY, nullable=False)          # quote currency, drives the liquidation price
    fx_open: Mapped[Decimal] = mapped_column(PRICE, nullable=False)             # account currency per 1 quote unit at open
    liquidation_price: Mapped[Decimal] = mapped_column(PRICE, nullable=False)
    fees: Mapped[Decimal] = mapped_column(MONEY, nullable=False, default=Decimal(0))
    funding: Mapped[Decimal] = mapped_column(MONEY, nullable=False, default=Decimal(0))   # + received, - paid
    slippage_bps: Mapped[float] = mapped_column(nullable=False, default=0.0)
    book_source: Mapped[str] = mapped_column(String(16), nullable=False)
    status: Mapped[str] = mapped_column(String(10), nullable=False, default=FuturesStatus.OPEN)
    exit_price: Mapped[Decimal | None] = mapped_column(PRICE)
    realised_pnl: Mapped[Decimal | None] = mapped_column(MONEY)
    source: Mapped[str] = mapped_column(String(8), nullable=False, default="manual")
    client_id: Mapped[str | None] = mapped_column(String(64))
    opened_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_funding_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
