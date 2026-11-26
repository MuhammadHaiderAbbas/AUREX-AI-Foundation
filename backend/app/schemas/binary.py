import uuid
from datetime import datetime
from decimal import Decimal
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class BinaryConfig(BaseModel):
    payout_rate: float
    expiries: list[int]
    break_even_win_rate: float
    coin_flip_expected_return: float
    minimum_stake: Decimal
    void_after_seconds: int
    notice: str


class BinaryCreate(BaseModel):
    account_id: uuid.UUID
    symbol: str = Field(min_length=1, max_length=32)
    direction: Literal["HIGHER", "LOWER"]
    stake: Decimal = Field(gt=0, max_digits=16, decimal_places=2)
    expiry_seconds: int = Field(gt=0)
    client_id: str | None = Field(default=None, pattern=r"^[A-Za-z0-9_-]{8,64}$")


class BinaryRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    account_id: uuid.UUID
    symbol: str
    direction: str
    stake: Decimal
    currency: str
    payout_rate: float
    potential_return: Decimal
    strike: Decimal
    expiry_seconds: int
    opened_at: datetime
    expires_at: datetime
    status: str
    settle_price: Decimal | None
    settle_price_at: datetime | None
    settled_at: datetime | None
    returned: Decimal | None
    pnl: Decimal | None
    void_reason: str | None
    client_id: str | None
    source: str = "manual"


class BinaryGroupStats(BaseModel):
    contracts: int
    open: int
    won: int
    lost: int
    ties: int
    void: int
    staked: Decimal
    net_pnl: Decimal
    win_rate: float | None
    return_on_stake: float | None


class BinaryStats(BinaryGroupStats):
    account_id: uuid.UUID
    currency: str
    payout_rate: float
    expiries: list[int]
    break_even_win_rate: float
    coin_flip_expected_return: float
    minimum_stake: Decimal
    void_after_seconds: int
    expected_return_at_win_rate: float | None
    edge_vs_break_even: float | None
    by_expiry: dict[str, BinaryGroupStats]
    by_symbol: dict[str, BinaryGroupStats]
    by_direction: dict[str, BinaryGroupStats]


def read(c: Any) -> BinaryRead:
    potential = (c.stake * (1 + Decimal(str(c.payout_rate)))).quantize(Decimal("0.01"))
    return BinaryRead(**{k: getattr(c, k) for k in BinaryRead.model_fields if k != "potential_return"},
                      potential_return=potential)


class BotControl(BaseModel):
    account_id: uuid.UUID
    action: Literal["start", "pause", "stop"]
    symbols: list[str] | None = Field(default=None, min_length=1, max_length=6)
    expiry_seconds: int | None = None
    stake_pct: float | None = Field(default=None, gt=0, le=5)
    min_confidence: float | None = Field(default=None, ge=0.5, lt=1)
    edge_margin: float | None = Field(default=None, ge=0, le=0.2)


class BotStats(BaseModel):
    contracts: int
    open: int
    won: int
    lost: int
    ties: int
    void: int
    win_rate: float | None
    staked: Decimal
    net_pnl: Decimal
    return_on_stake: float | None


class BotRead(BaseModel):
    account_id: uuid.UUID
    status: str
    symbols: list[str]
    expiry_seconds: int
    stake_pct: float
    min_confidence: float
    edge_margin: float
    guard_min_contracts: int
    started_at: datetime | None
    last_cycle_at: datetime | None
    paused_reason: str | None
    interval_seconds: float
    data_mode: str
    break_even_win_rate: float
    payout_rate: float
    stats: BotStats
    recent: list[dict[str, Any]]
