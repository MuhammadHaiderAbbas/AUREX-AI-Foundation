import uuid
from datetime import datetime
from decimal import Decimal
from typing import Any, Literal

from pydantic import BaseModel, Field

from app.schemas.common import ORMModel


class OrderCreate(BaseModel):
    account_id: uuid.UUID
    symbol: str = Field(max_length=32)
    side: Literal["BUY", "SELL"]
    type: Literal["MARKET", "LIMIT", "STOP"] = "MARKET"
    quantity: Decimal = Field(gt=0, max_digits=28, decimal_places=10)
    limit_price: Decimal | None = Field(default=None, gt=0, max_digits=28, decimal_places=10)
    stop_price: Decimal | None = Field(default=None, gt=0, max_digits=28, decimal_places=10)
    time_in_force: Literal["GTC", "DAY"] = "GTC"
    client_order_id: str | None = Field(default=None, min_length=8, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")


class OrderEventRead(ORMModel):
    type: str
    detail: dict[str, Any]
    created_at: datetime


class ExecutionRead(ORMModel):
    id: uuid.UUID
    order_id: uuid.UUID
    account_id: uuid.UUID
    symbol: str
    side: str
    quantity: Decimal
    price: Decimal
    reference_price: Decimal
    mid_price: Decimal
    fx_rate: Decimal
    fee: Decimal
    spread_cost: Decimal
    slippage_cost: Decimal
    realised_pnl: Decimal | None
    ledger_transaction_id: uuid.UUID
    executed_at: datetime


class OrderRead(ORMModel):
    id: uuid.UUID
    account_id: uuid.UUID
    symbol: str
    side: str
    type: str
    quantity: Decimal
    limit_price: Decimal | None
    stop_price: Decimal | None
    time_in_force: str
    status: str
    filled_qty: Decimal
    avg_fill_price: Decimal | None
    client_order_id: str | None
    source: str
    reject_reason: str | None
    expires_at: datetime | None
    created_at: datetime
    updated_at: datetime


class OrderDetail(OrderRead):
    events: list[OrderEventRead]
    executions: list[ExecutionRead]


class PositionRead(BaseModel):
    id: uuid.UUID
    symbol: str
    asset_class: str
    quantity: Decimal
    avg_price: Decimal
    last: Decimal
    bid: Decimal
    quote_currency: str
    fx_rate: Decimal
    cost_basis: Decimal
    market_value: Decimal
    unrealised_pnl: Decimal
    unrealised_pct: float
    realised_pnl: Decimal
    fees: Decimal
    opened_at: datetime
    price_as_of: datetime | None
    stale: bool
    price_decimals: int


class ClosedPositionRead(ORMModel):
    id: uuid.UUID
    symbol: str
    avg_price: Decimal
    realised_pnl: Decimal
    fees: Decimal
    opened_at: datetime
    closed_at: datetime | None


class PortfolioSummary(BaseModel):
    account_id: uuid.UUID
    account_name: str
    currency: str
    cash: Decimal
    available_cash: Decimal
    investments_at_cost: Decimal
    market_value: Decimal
    equity: Decimal
    unrealised_pnl: Decimal
    realised_pnl: Decimal
    fees: Decimal
    exposure: float
    open_positions: int
    allocation: dict[str, float]
    positions: list[PositionRead]


class SnapshotRead(ORMModel):
    taken_at: datetime
    cash: Decimal
    market_value: Decimal
    equity: Decimal
    reason: str
