import uuid
from datetime import datetime
from decimal import Decimal

from pydantic import BaseModel, Field, field_validator

from app.schemas.common import ORMModel


def _money(v: Decimal) -> Decimal:
    if not v.is_finite():
        raise ValueError("Amount must be a finite number")
    if v <= 0:
        raise ValueError("Amount must be greater than zero")
    exp = v.as_tuple().exponent
    if isinstance(exp, int) and exp < -8:
        raise ValueError("Amount supports at most 8 decimal places")
    return v


class PaperAccountCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    base_currency: str = Field(default="USD", min_length=3, max_length=3)
    starting_balance: Decimal | None = None

    @field_validator("name")
    @classmethod
    def _name(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("Name is required")
        return v

    @field_validator("base_currency")
    @classmethod
    def _ccy(cls, v: str) -> str:
        return v.upper()

    @field_validator("starting_balance")
    @classmethod
    def _bal(cls, v: Decimal | None) -> Decimal | None:
        return None if v is None else _money(v)


class CashMovement(BaseModel):
    amount: Decimal
    description: str = Field(default="", max_length=500)

    @field_validator("amount")
    @classmethod
    def _amt(cls, v: Decimal) -> Decimal:
        return _money(v)


class BalanceLine(BaseModel):
    code: str
    name: str
    type: str
    currency: str
    balance: Decimal


class AccountBalances(BaseModel):
    trading_account_id: uuid.UUID
    currency: str
    cash: Decimal
    investments: Decimal
    equity: Decimal
    lines: list[BalanceLine]
    ledger_balanced: bool


class TradingAccountRead(ORMModel):
    id: uuid.UUID
    name: str
    mode: str
    base_currency: str
    status: str
    created_at: datetime
    cash_balance: Decimal = Decimal(0)
    equity: Decimal = Decimal(0)


class LedgerEntryRead(BaseModel):
    ledger_code: str
    direction: str
    amount: Decimal
    currency: str


class LedgerTransactionRead(BaseModel):
    id: uuid.UUID
    type: str
    description: str
    created_at: datetime
    created_by: uuid.UUID | None
    entries: list[LedgerEntryRead]
