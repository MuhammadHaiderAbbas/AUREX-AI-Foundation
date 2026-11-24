"""Risk engine state (Phase 9): per-account limits and breakers, decisions, events, system halt."""

import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import (
    JSON,
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    Numeric,
    String,
    Text,
    Uuid,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.database.base import Base, Timestamps, UUIDPk, utcnow

MONEY = Numeric(28, 8)


class AutopilotStatus:
    STOPPED = "STOPPED"
    RUNNING = "RUNNING"
    PAUSED = "PAUSED"


class RiskProfile(Timestamps, Base):
    """Limits and live breaker state for one trading account (one row per account)."""

    __tablename__ = "risk_profiles"
    __table_args__ = (
        CheckConstraint("risk_per_trade_pct > 0 AND risk_per_trade_pct <= 2", name="risk_per_trade_range"),
        CheckConstraint("max_position_pct > 0 AND max_position_pct <= 50", name="position_range"),
        CheckConstraint("max_gross_exposure_pct > 0 AND max_gross_exposure_pct <= 100", name="exposure_range"),
        CheckConstraint("max_open_positions BETWEEN 1 AND 10", name="positions_range"),
        CheckConstraint("daily_loss_limit_pct > 0 AND daily_loss_limit_pct <= 5", name="daily_loss_range"),
        CheckConstraint("max_drawdown_pct > 0 AND max_drawdown_pct <= 25", name="drawdown_range"),
        CheckConstraint("max_orders_per_minute BETWEEN 1 AND 60", name="velocity_range"),
        CheckConstraint("price_collar_pct > 0 AND price_collar_pct <= 20", name="collar_range"),
        CheckConstraint("autopilot_status IN ('STOPPED','RUNNING','PAUSED')", name="autopilot_valid"),
        CheckConstraint("binary_max_stake_pct > 0 AND binary_max_stake_pct <= 5", name="binary_stake_range"),
        CheckConstraint("binary_max_open BETWEEN 1 AND 10", name="binary_open_range"),
    )

    account_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("trading_accounts.id", ondelete="CASCADE"),
                                                  primary_key=True)
    # limits (percent of equity unless noted)
    risk_per_trade_pct: Mapped[float] = mapped_column(Float, nullable=False, default=0.5)
    max_position_pct: Mapped[float] = mapped_column(Float, nullable=False, default=20.0)
    max_gross_exposure_pct: Mapped[float] = mapped_column(Float, nullable=False, default=50.0)
    max_open_positions: Mapped[int] = mapped_column(Integer, nullable=False, default=5)
    daily_loss_limit_pct: Mapped[float] = mapped_column(Float, nullable=False, default=2.0)
    max_drawdown_pct: Mapped[float] = mapped_column(Float, nullable=False, default=10.0)
    max_orders_per_minute: Mapped[int] = mapped_column(Integer, nullable=False, default=20)
    price_collar_pct: Mapped[float] = mapped_column(Float, nullable=False, default=5.0)
    # binary options (paper): stake per contract as % of equity, concurrent contracts, on/off
    binary_max_stake_pct: Mapped[float] = mapped_column(Float, nullable=False, default=2.0, server_default="2.0")
    binary_max_open: Mapped[int] = mapped_column(Integer, nullable=False, default=3, server_default="3")
    binary_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default="true")
    # kill switch and breakers
    kill_switch: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    kill_reason: Mapped[str | None] = mapped_column(Text)
    kill_engaged_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    daily_halt_date: Mapped[date | None] = mapped_column(Date)
    drawdown_halted: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    drawdown_halted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # contribution-neutral equity tracking (see docs/architecture/risk-engine.md)
    peak_pnl_equity: Mapped[Decimal | None] = mapped_column(MONEY)
    day_date: Mapped[date | None] = mapped_column(Date)
    day_start_pnl_equity: Mapped[Decimal | None] = mapped_column(MONEY)
    day_start_equity: Mapped[Decimal | None] = mapped_column(MONEY)
    # autopilot
    autopilot_status: Mapped[str] = mapped_column(String(8), nullable=False, default=AutopilotStatus.STOPPED)
    autopilot_symbols: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)
    autopilot_last_cycle_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class RiskDecision(UUIDPk, Base):
    """Append-only record of every pre-trade evaluation (approved or not)."""

    __tablename__ = "risk_decisions"

    account_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("trading_accounts.id", ondelete="CASCADE"),
                                                  nullable=False, index=True)
    order_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("orders.id", ondelete="RESTRICT"), index=True)
    proposal_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    binary_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, index=True)
    source: Mapped[str] = mapped_column(String(12), nullable=False)
    symbol: Mapped[str] = mapped_column(String(32), nullable=False)
    side: Mapped[str] = mapped_column(String(4), nullable=False)
    approved: Mapped[bool] = mapped_column(Boolean, nullable=False)
    reason: Mapped[str | None] = mapped_column(Text)
    checks: Mapped[list[dict[str, Any]]] = mapped_column(JSON, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now(),
                                                 default=utcnow, index=True)


class RiskEvent(UUIDPk, Base):
    """Append-only breaker trips, kill-switch changes, autopilot actions. account_id NULL = system-wide."""

    __tablename__ = "risk_events"

    account_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("trading_accounts.id", ondelete="CASCADE"),
                                                         index=True)
    type: Mapped[str] = mapped_column(String(32), nullable=False)
    message: Mapped[str] = mapped_column(Text, nullable=False)
    detail: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False, default=dict)
    actor_user_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now(),
                                                 default=utcnow, index=True)


class SystemControl(Base):
    """Platform-wide switches, e.g. key 'trading_halt' -> {"halted": bool, "reason": str}."""

    __tablename__ = "system_controls"

    key: Mapped[str] = mapped_column(String(40), primary_key=True)
    value: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False)
    updated_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now(),
                                                 default=utcnow, onupdate=utcnow)
