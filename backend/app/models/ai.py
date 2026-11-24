import uuid
from datetime import datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import (
    JSON,
    Boolean,
    CheckConstraint,
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
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database.base import Base, UUIDPk, utcnow

PRICE = Numeric(28, 10)
MONEY = Numeric(28, 8)


class AIAgent(Base):
    """Configuration of a specialist agent (seeded; admins may tune weight / enable)."""

    __tablename__ = "ai_agents"
    __table_args__ = (
        CheckConstraint("kind IN ('directional','gate')", name="kind_valid"),
        CheckConstraint("weight >= 0 AND weight <= 1", name="weight_range"),
    )

    name: Mapped[str] = mapped_column(String(32), primary_key=True)
    display_name: Mapped[str] = mapped_column(String(60), nullable=False)
    role: Mapped[str] = mapped_column(Text, nullable=False)
    kind: Mapped[str] = mapped_column(String(12), nullable=False)
    weight: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    version: Mapped[str] = mapped_column(String(16), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), default=utcnow,
        onupdate=utcnow)


class AIRun(UUIDPk, Base):
    __tablename__ = "ai_runs"
    __table_args__ = (
        CheckConstraint("decision IN ('BUY','NO_TRADE')", name="decision_valid"),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    account_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("trading_accounts.id", ondelete="SET NULL"))
    symbol: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    decision: Mapped[str] = mapped_column(String(10), nullable=False)
    bias: Mapped[str] = mapped_column(String(10), nullable=False)
    net_score: Mapped[float] = mapped_column(Float, nullable=False)
    agreement: Mapped[float] = mapped_column(Float, nullable=False)
    coverage: Mapped[float] = mapped_column(Float, nullable=False)
    confidence: Mapped[float] = mapped_column(Float, nullable=False)
    reasons: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)
    weights: Mapped[dict[str, float]] = mapped_column(JSON, nullable=False, default=dict)
    context: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, default=dict)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    finished_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    latency_ms: Mapped[int] = mapped_column(Integer, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), default=utcnow,
        index=True)

    findings: Mapped[list["AIFinding"]] = relationship(
        lazy="selectin", cascade="all, delete-orphan", order_by="AIFinding.ordinal")
    proposal: Mapped["TradeProposal | None"] = relationship(lazy="selectin", uselist=False)


class AIFinding(UUIDPk, Base):
    __tablename__ = "ai_findings"
    __table_args__ = (
        CheckConstraint("status IN ('ok','abstain','error')", name="status_valid"),
        CheckConstraint("direction IN (-1, 0, 1)", name="direction_valid"),
    )

    run_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("ai_runs.id", ondelete="CASCADE"), nullable=False, index=True)
    ordinal: Mapped[int] = mapped_column(Integer, nullable=False)
    agent: Mapped[str] = mapped_column(String(32), ForeignKey("ai_agents.name"), nullable=False)
    status: Mapped[str] = mapped_column(String(8), nullable=False)
    direction: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    score: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    confidence: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    summary: Mapped[str] = mapped_column(Text, nullable=False, default="")
    evidence: Mapped[list[dict[str, str]]] = mapped_column(JSON, nullable=False, default=list)
    duration_ms: Mapped[int] = mapped_column(Integer, nullable=False, default=0)


class TradeProposal(UUIDPk, Base):
    """A structured trade proposal. It never executes on its own: it becomes a paper order
    only after the independent risk engine (Phase 9) approves it."""

    __tablename__ = "trade_proposals"
    __table_args__ = (
        CheckConstraint("direction IN ('BUY','SELL')", name="direction_valid"),
        CheckConstraint("status IN ('PENDING_RISK_REVIEW','DISMISSED','EXECUTED','RISK_REJECTED')",
                        name="status_valid"),
        CheckConstraint("stop_loss < entry_price AND take_profit > entry_price",
                        name="levels_consistent"),
        CheckConstraint("quantity > 0", name="quantity_positive"),
        CheckConstraint("risk_check_required", name="risk_check_mandatory"),
    )

    run_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("ai_runs.id", ondelete="CASCADE"), nullable=False, unique=True)
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    account_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("trading_accounts.id", ondelete="CASCADE"), nullable=False)
    symbol: Mapped[str] = mapped_column(String(32), nullable=False)
    direction: Mapped[str] = mapped_column(String(4), nullable=False)
    strategy_id: Mapped[str] = mapped_column(String(40), nullable=False)
    entry_type: Mapped[str] = mapped_column(String(8), nullable=False)
    entry_price: Mapped[Decimal] = mapped_column(PRICE, nullable=False)
    stop_loss: Mapped[Decimal] = mapped_column(PRICE, nullable=False)
    take_profit: Mapped[Decimal] = mapped_column(PRICE, nullable=False)
    quantity: Mapped[Decimal] = mapped_column(PRICE, nullable=False)
    notional: Mapped[Decimal] = mapped_column(MONEY, nullable=False)
    risk_amount: Mapped[Decimal] = mapped_column(MONEY, nullable=False)
    account_currency: Mapped[str] = mapped_column(String(3), nullable=False)
    confidence: Mapped[float] = mapped_column(Float, nullable=False)
    reward_risk: Mapped[float] = mapped_column(Float, nullable=False)
    invalidation_conditions: Mapped[list[str]] = mapped_column(JSON, nullable=False)
    risk_check_required: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    status: Mapped[str] = mapped_column(String(24), nullable=False, default="PENDING_RISK_REVIEW")
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), default=utcnow,
        index=True)
    dismissed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Phase 9: outcome of the risk gate
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    decision_reason: Mapped[str | None] = mapped_column(Text)
    order_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
