import uuid
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

from pydantic import BaseModel, Field, computed_field

from app.schemas.common import ORMModel


class AgentRead(ORMModel):
    name: str
    display_name: str
    role: str
    kind: str
    weight: float
    enabled: bool
    version: str


class AgentUpdate(BaseModel):
    enabled: bool | None = None
    weight: float | None = Field(default=None, ge=0, le=1)


class FindingRead(ORMModel):
    agent: str
    status: str
    direction: int
    score: float
    confidence: float
    summary: str
    evidence: list[dict[str, str]]
    duration_ms: int


class ProposalRead(ORMModel):
    id: uuid.UUID
    run_id: uuid.UUID
    account_id: uuid.UUID
    symbol: str
    direction: str
    strategy_id: str
    entry_type: str
    entry_price: Decimal
    stop_loss: Decimal
    take_profit: Decimal
    quantity: Decimal
    notional: Decimal
    risk_amount: Decimal
    account_currency: str
    confidence: float
    reward_risk: float
    invalidation_conditions: list[str]
    risk_check_required: bool
    status: str
    expires_at: datetime
    created_at: datetime
    dismissed_at: datetime | None

    @computed_field
    @property
    def effective_status(self) -> str:
        if self.status == "PENDING_RISK_REVIEW" and self.expires_at <= datetime.now(UTC):
            return "EXPIRED"
        return self.status


class RunSummary(ORMModel):
    id: uuid.UUID
    symbol: str
    decision: str
    bias: str
    net_score: float
    agreement: float
    coverage: float
    confidence: float
    created_at: datetime
    latency_ms: int


class RunRead(RunSummary):
    account_id: uuid.UUID | None
    reasons: list[str]
    weights: dict[str, float]
    context: dict[str, Any]
    started_at: datetime
    finished_at: datetime
    findings: list[FindingRead]
    proposal: ProposalRead | None


class RunRequest(BaseModel):
    symbol: str = Field(min_length=1, max_length=32)
    account_id: uuid.UUID | None = None
