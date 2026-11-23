import hashlib
import json
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import AuditLog

GENESIS_HASH = "0" * 64
_AUDIT_LOCK_KEY = 0x41555245  # "AURE" — serialises chain appends


@dataclass(frozen=True)
class AuditContext:
    actor_user_id: uuid.UUID | None = None
    ip_address: str | None = None
    request_id: str | None = None

    def as_actor(self, user_id: uuid.UUID) -> "AuditContext":
        return AuditContext(user_id, self.ip_address, self.request_id)


def _normalise(details: dict[str, Any] | None) -> dict[str, Any]:
    return json.loads(json.dumps(details or {}, default=str))


def _compute_hash(prev_hash: str, rec: dict[str, Any]) -> str:
    canonical = json.dumps(rec, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256((prev_hash + canonical).encode()).hexdigest()


def _record(log: AuditLog) -> dict[str, Any]:
    return {
        "occurred_at": log.occurred_at.astimezone(UTC).isoformat(),
        "actor_user_id": str(log.actor_user_id) if log.actor_user_id else None,
        "action": log.action,
        "resource_type": log.resource_type,
        "resource_id": log.resource_id,
        "outcome": log.outcome,
        "ip_address": log.ip_address,
        "request_id": log.request_id,
        "details": log.details,
    }


class AuditService:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def record(
        self,
        ctx: AuditContext,
        action: str,
        *,
        resource_type: str | None = None,
        resource_id: str | uuid.UUID | None = None,
        outcome: str = "success",
        details: dict[str, Any] | None = None,
    ) -> AuditLog:
        """Append to the audit chain inside the caller's transaction."""
        await self.db.execute(text("SELECT pg_advisory_xact_lock(:k)"), {"k": _AUDIT_LOCK_KEY})
        prev = await self.db.scalar(select(AuditLog.hash).order_by(AuditLog.id.desc()).limit(1))
        log = AuditLog(
            occurred_at=datetime.now(UTC),
            actor_user_id=ctx.actor_user_id,
            action=action,
            resource_type=resource_type,
            resource_id=str(resource_id) if resource_id is not None else None,
            outcome=outcome,
            ip_address=ctx.ip_address,
            request_id=ctx.request_id,
            details=_normalise(details),
            prev_hash=prev or GENESIS_HASH,
        )
        log.hash = _compute_hash(log.prev_hash, _record(log))
        self.db.add(log)
        await self.db.flush()
        return log

    async def list(
        self, *, limit: int, offset: int, action: str | None = None,
        actor_user_id: uuid.UUID | None = None,
    ) -> tuple[list[AuditLog], int]:
        q = select(AuditLog)
        if action:
            q = q.where(AuditLog.action == action)
        if actor_user_id:
            q = q.where(AuditLog.actor_user_id == actor_user_id)
        total = await self.db.scalar(select(func.count()).select_from(q.subquery()))
        rows = await self.db.scalars(q.order_by(AuditLog.id.desc()).limit(limit).offset(offset))
        return list(rows), int(total or 0)

    async def verify_chain(self) -> dict[str, Any]:
        prev = GENESIS_HASH
        checked = 0
        result = await self.db.stream_scalars(select(AuditLog).order_by(AuditLog.id))
        async for log in result:
            checked += 1
            if log.prev_hash != prev:
                return {"valid": False, "records_checked": checked,
                        "first_invalid_id": log.id, "reason": "prev_hash does not link"}
            if _compute_hash(prev, _record(log)) != log.hash:
                return {"valid": False, "records_checked": checked,
                        "first_invalid_id": log.id, "reason": "record hash mismatch"}
            prev = log.hash
        return {"valid": True, "records_checked": checked}
