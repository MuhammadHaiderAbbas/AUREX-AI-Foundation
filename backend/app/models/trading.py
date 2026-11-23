import uuid
from datetime import datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import (
    JSON,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    Uuid,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.database.base import Base, Timestamps, UUIDPk, utcnow

QTY = Numeric(28, 10)
PRICE = Numeric(28, 10)
MONEY = Numeric(28, 8)


class OrderStatus:
    OPEN = "OPEN"
    FILLED = "FILLED"
    CANCELLED = "CANCELLED"
    REJECTED = "REJECTED"
    EXPIRED = "EXPIRED"
    TERMINAL = (FILLED, CANCELLED, REJECTED, EXPIRED)


class Order(UUIDPk, Timestamps, Base):
    __tablename__ = "orders"
    __table_args__ = (
        CheckConstraint("side IN ('BUY','SELL')", name="side_valid"),
        CheckConstraint("type IN ('MARKET','LIMIT','STOP')", name="type_valid"),
        CheckConstraint("status IN ('OPEN','FILLED','CANCELLED','REJECTED','EXPIRED')", name="status_valid"),
        CheckConstraint("time_in_force IN ('GTC','DAY')", name="tif_valid"),
        CheckConstraint("quantity > 0", name="qty_positive"),
        CheckConstraint("type <> 'LIMIT' OR (limit_price IS NOT NULL AND limit_price > 0)", name="limit_has_price"),
        CheckConstraint("type <> 'STOP' OR (stop_price IS NOT NULL AND stop_price > 0)", name="stop_has_price"),
        UniqueConstraint("account_id", "client_order_id", name="uq_order_client_id"),
        Index("ix_orders_open", "status", postgresql_where=text("status = 'OPEN'")),
    )

    account_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("trading_accounts.id", ondelete="RESTRICT"),
                                                  nullable=False, index=True)
    user_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("users.id", ondelete="RESTRICT"), nullable=False)
    instrument_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("instruments.id"), nullable=False)
    symbol: Mapped[str] = mapped_column(String(32), nullable=False)
    side: Mapped[str] = mapped_column(String(4), nullable=False)
    type: Mapped[str] = mapped_column(String(6), nullable=False)
    quantity: Mapped[Decimal] = mapped_column(QTY, nullable=False)
    limit_price: Mapped[Decimal | None] = mapped_column(PRICE)
    stop_price: Mapped[Decimal | None] = mapped_column(PRICE)
    time_in_force: Mapped[str] = mapped_column(String(3), nullable=False, default="GTC")
    status: Mapped[str] = mapped_column(String(10), nullable=False)
    filled_qty: Mapped[Decimal] = mapped_column(QTY, nullable=False, default=Decimal(0))
    avg_fill_price: Mapped[Decimal | None] = mapped_column(PRICE)
    client_order_id: Mapped[str | None] = mapped_column(String(64))
    source: Mapped[str] = mapped_column(String(12), nullable=False, default="manual")
    reject_reason: Mapped[str | None] = mapped_column(Text)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class OrderEvent(UUIDPk, Base):
    """Append-only order lifecycle history."""

    __tablename__ = "order_events"

    order_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("orders.id", ondelete="RESTRICT"),
                                                nullable=False, index=True)
    type: Mapped[str] = mapped_column(String(16), nullable=False)
    detail: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), default=utcnow)


class Execution(UUIDPk, Base):
    """A simulated fill. Append-only; linked to the ledger transaction it produced."""

    __tablename__ = "executions"
    __table_args__ = (CheckConstraint("quantity > 0 AND price > 0", name="positive"),)

    order_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("orders.id", ondelete="RESTRICT"),
                                                nullable=False, index=True)
    account_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("trading_accounts.id", ondelete="RESTRICT"),
                                                  nullable=False, index=True)
    symbol: Mapped[str] = mapped_column(String(32), nullable=False)
    side: Mapped[str] = mapped_column(String(4), nullable=False)
    quantity: Mapped[Decimal] = mapped_column(QTY, nullable=False)
    price: Mapped[Decimal] = mapped_column(PRICE, nullable=False)          # quote currency
    reference_price: Mapped[Decimal] = mapped_column(PRICE, nullable=False)  # bid/ask at fill time
    mid_price: Mapped[Decimal] = mapped_column(PRICE, nullable=False)
    fx_rate: Mapped[Decimal] = mapped_column(PRICE, nullable=False)        # account ccy per quote ccy
    fee: Mapped[Decimal] = mapped_column(MONEY, nullable=False)            # account currency
    spread_cost: Mapped[Decimal] = mapped_column(MONEY, nullable=False)    # account currency
    slippage_cost: Mapped[Decimal] = mapped_column(MONEY, nullable=False)  # account currency
    realised_pnl: Mapped[Decimal | None] = mapped_column(MONEY)            # sells only, before fees
    ledger_transaction_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("ledger_transactions.id"), nullable=False)
    executed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class Position(UUIDPk, Timestamps, Base):
    __tablename__ = "positions"
    __table_args__ = (
        CheckConstraint("quantity >= 0", name="no_short"),
        CheckConstraint("status IN ('OPEN','CLOSED')", name="status_valid"),
        Index("uq_open_position", "account_id", "symbol", unique=True, postgresql_where=text("status = 'OPEN'")),
    )

    account_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("trading_accounts.id", ondelete="RESTRICT"),
                                                  nullable=False, index=True)
    instrument_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("instruments.id"), nullable=False)
    symbol: Mapped[str] = mapped_column(String(32), nullable=False)
    quantity: Mapped[Decimal] = mapped_column(QTY, nullable=False)
    avg_price: Mapped[Decimal] = mapped_column(PRICE, nullable=False)       # quote currency, ex-fees
    cost_basis: Mapped[Decimal] = mapped_column(MONEY, nullable=False)      # account currency, ex-fees
    realised_pnl: Mapped[Decimal] = mapped_column(MONEY, nullable=False, default=Decimal(0))
    fees: Mapped[Decimal] = mapped_column(MONEY, nullable=False, default=Decimal(0))
    status: Mapped[str] = mapped_column(String(6), nullable=False, default="OPEN")
    opened_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class PortfolioSnapshot(UUIDPk, Base):
    __tablename__ = "portfolio_snapshots"

    account_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("trading_accounts.id", ondelete="CASCADE"),
                                                  nullable=False, index=True)
    taken_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, index=True)
    cash: Mapped[Decimal] = mapped_column(MONEY, nullable=False)
    market_value: Mapped[Decimal] = mapped_column(MONEY, nullable=False)
    equity: Mapped[Decimal] = mapped_column(MONEY, nullable=False)
    reason: Mapped[str] = mapped_column(String(16), nullable=False)
