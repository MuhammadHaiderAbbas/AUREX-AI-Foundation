import uuid
from datetime import datetime
from decimal import Decimal
from typing import Any, Literal

from pydantic import BaseModel, Field

from app.schemas.common import ORMModel


class RiskLimits(BaseModel):
    risk_per_trade_pct: float
    max_position_pct: float
    max_gross_exposure_pct: float
    max_open_positions: int
    daily_loss_limit_pct: float
    max_drawdown_pct: float
    max_orders_per_minute: int
    price_collar_pct: float


class RiskLimitsUpdate(BaseModel):
    risk_per_trade_pct: float | None = Field(default=None, gt=0, le=2)
    max_position_pct: float | None = Field(default=None, gt=0, le=50)
    max_gross_exposure_pct: float | None = Field(default=None, gt=0, le=100)
    max_open_positions: int | None = Field(default=None, ge=1, le=10)
    daily_loss_limit_pct: float | None = Field(default=None, gt=0, le=5)
    max_drawdown_pct: float | None = Field(default=None, gt=0, le=25)
    max_orders_per_minute: int | None = Field(default=None, ge=1, le=60)
    price_collar_pct: float | None = Field(default=None, gt=0, le=20)


class RiskState(BaseModel):
    kill_switch: bool
    kill_reason: str | None
    kill_engaged_at: datetime | None
    daily_halted: bool
    drawdown_halted: bool
    drawdown_halted_at: datetime | None
    blocked_reason: str | None


class RiskMetrics(BaseModel):
    equity: Decimal
    pnl_equity: Decimal
    peak_pnl_equity: Decimal | None
    day_start_equity: Decimal | None
    daily_pnl: Decimal
    daily_loss_pct: float
    drawdown_pct: float
    exposure_pct: float
    largest_position_pct: float
    open_positions: int


class AutopilotRead(BaseModel):
    status: str
    symbols: list[str]
    last_cycle_at: datetime | None
    interval_seconds: float


class SystemHalt(BaseModel):
    halted: bool
    reason: str | None = None
    since: str | None = None


class RiskOverview(BaseModel):
    account_id: uuid.UUID
    currency: str
    limits: RiskLimits
    defaults: dict[str, float]
    ceilings: dict[str, float]
    state: RiskState
    metrics: RiskMetrics
    autopilot: AutopilotRead
    system: SystemHalt


class KillSwitchRequest(BaseModel):
    engaged: bool
    reason: str | None = Field(default=None, max_length=300)


class AutopilotRequest(BaseModel):
    action: Literal["start", "pause", "stop"]
    symbols: list[str] | None = Field(default=None, min_length=1, max_length=5)


class EmergencyStopRequest(BaseModel):
    flatten: bool = False
    reason: str | None = Field(default=None, max_length=300)


class SystemHaltRequest(BaseModel):
    halted: bool
    reason: str | None = Field(default=None, max_length=300)


class RiskDecisionRead(ORMModel):
    id: uuid.UUID
    order_id: uuid.UUID | None
    proposal_id: uuid.UUID | None
    source: str
    symbol: str
    side: str
    approved: bool
    reason: str | None
    checks: list[dict[str, Any]]
    created_at: datetime


class RiskEventRead(ORMModel):
    id: uuid.UUID
    account_id: uuid.UUID | None
    type: str
    message: str
    detail: dict[str, Any]
    created_at: datetime
