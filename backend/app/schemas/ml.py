import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field

from app.schemas.common import ORMModel


class AlgorithmRead(BaseModel):
    key: str
    label: str
    description: str
    params: dict[str, Any]


class TrainRequest(BaseModel):
    symbol: str = Field(min_length=1, max_length=32)
    algorithm: str = Field(min_length=1, max_length=24)
    horizon: int = Field(default=4, ge=1, le=24)
    days: int = Field(default=180, ge=60, le=365)


class VersionSummary(ORMModel):
    id: uuid.UUID
    model_id: uuid.UUID
    symbol: str
    version: int
    status: str
    eligible: bool
    eligibility_note: str
    data_source: str
    trained_at: datetime
    promoted_at: datetime | None
    retired_at: datetime | None
    n_samples: int
    summary: dict[str, Any]


class ModelRead(ORMModel):
    id: uuid.UUID
    name: str
    symbol: str
    timeframe: str
    horizon: int
    algorithm: str
    created_at: datetime
    versions: list[VersionSummary]


class EvaluationRead(ORMModel):
    id: uuid.UUID
    kind: str
    status: str
    metrics: dict[str, Any]
    created_at: datetime


class VersionDetail(VersionSummary):
    gates: list[dict[str, Any]]
    metrics: dict[str, Any]
    params: dict[str, Any]
    features: list[str]
    feature_importance: dict[str, float]
    train_from: datetime
    train_to: datetime
    artifact_sha256: str
    model: dict[str, Any]
    evaluations: list[EvaluationRead]
