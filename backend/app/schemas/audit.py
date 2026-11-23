import uuid
from datetime import datetime
from typing import Any

from app.schemas.common import ORMModel


class AuditLogRead(ORMModel):
    id: int
    occurred_at: datetime
    actor_user_id: uuid.UUID | None
    action: str
    resource_type: str | None
    resource_id: str | None
    outcome: str
    ip_address: str | None
    request_id: str | None
    details: dict[str, Any]
    hash: str


class AuditVerifyResult(ORMModel):
    valid: bool
    records_checked: int
    first_invalid_id: int | None = None
    reason: str | None = None
