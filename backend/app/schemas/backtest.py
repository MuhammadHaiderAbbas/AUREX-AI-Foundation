import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field

from app.schemas.common import ORMModel


class StrategyRead(BaseModel):
    key: str
    name: str
    description: str
    defaults: dict[str, Any]
    params: dict[str, dict[str, Any]]
    grid_size: int


class CostOverrides(BaseModel):
    fee_bps: float | None = Field(default=None, ge=0, le=100)
    half_spread_bps: float | None = Field(default=None, ge=0, le=100)
    slippage_bps: float | None = Field(default=None, ge=0, le=100)
    latency_bars: int | None = Field(default=None, ge=1, le=6)


class BacktestRequest(BaseModel):
    strategy: str = Field(max_length=40)
    symbol: str = Field(max_length=32)
    days: int = Field(default=180, ge=30, le=365)
    params: dict[str, float] | None = None
    optimise: bool = True
    capital: float = Field(default=100_000, ge=1_000, le=10_000_000)
    costs: CostOverrides = Field(default_factory=CostOverrides)


class BacktestSummary(ORMModel):
    id: uuid.UUID
    strategy_key: str
    symbol: str
    days: int
    params: dict[str, Any]
    data_source: str
    oos_sharpe: float
    oos_return: float
    created_at: datetime
    latency_ms: int


class BacktestRead(BacktestSummary):
    timeframe: str
    config: dict[str, Any]
    period_from: datetime
    period_to: datetime
    result: dict[str, Any]
