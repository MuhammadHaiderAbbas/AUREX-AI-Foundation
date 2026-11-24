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


# -- export & offline verification (Phase 11) ------------------------------------------------
EXPORT_FORMAT = "aurex-audit-export/1"


def export_line(log: AuditLog) -> dict[str, Any]:
    return {"id": log.id, **_record(log), "prev_hash": log.prev_hash, "hash": log.hash}


async def export_lines(db: AsyncSession, from_id: int = 1):
    """JSON Lines: a header, then one record per line, oldest first. Everything needed to
    re-verify the chain offline is included, so an export can be checked without database access."""
    first = await db.scalar(select(AuditLog).where(AuditLog.id >= from_id).order_by(AuditLog.id).limit(1))
    total = await db.scalar(select(func.count()).select_from(AuditLog).where(AuditLog.id >= from_id))
    yield json.dumps({"format": EXPORT_FORMAT, "exported_at": datetime.now(UTC).isoformat(), "from_id": from_id,
                      "records": int(total or 0), "anchor_prev_hash": first.prev_hash if first else None}) + "\n"
    result = await db.stream_scalars(select(AuditLog).where(AuditLog.id >= from_id).order_by(AuditLog.id))
    async for log in result:
        yield json.dumps(export_line(log), sort_keys=True, default=str) + "\n"


def _invalid(checked: int, record_id: int, reason: str) -> dict[str, Any]:
    return {"valid": False, "records_checked": checked, "first_invalid_id": record_id, "reason": reason}


def verify_export(lines) -> dict[str, Any]:
    """Re-verify an export: header, contiguous ids, prev-hash links and every record hash."""
    it = iter(lines)
    try:
        header = json.loads(next(it))
    except (StopIteration, json.JSONDecodeError):
        return {"valid": False, "records_checked": 0, "reason": "missing or unreadable header"}
    if header.get("format") != EXPORT_FORMAT:
        return {"valid": False, "records_checked": 0, "reason": "unknown export format"}
    prev = header.get("anchor_prev_hash") or GENESIS_HASH
    if header.get("from_id", 1) == 1 and prev != GENESIS_HASH:
        return {"valid": False, "records_checked": 0, "reason": "full export must start at the genesis hash"}
    checked, last_id, last_hash = 0, None, prev
    for raw in it:
        if not raw.strip():
            continue
        rec = json.loads(raw)
        if last_id is not None and rec["id"] != last_id + 1:
            return _invalid(checked, rec["id"], "gap in record ids")
        if rec["prev_hash"] != prev:
            return _invalid(checked, rec["id"], "prev_hash does not link")
        body = {k: rec[k] for k in ("occurred_at", "actor_user_id", "action", "resource_type", "resource_id",
                                    "outcome", "ip_address", "request_id", "details")}
        if _compute_hash(prev, body) != rec["hash"]:
            return _invalid(checked, rec["id"], "record hash mismatch")
        prev, last_id, last_hash, checked = rec["hash"], rec["id"], rec["hash"], checked + 1
    if checked != header.get("records", checked):
        return {"valid": False, "records_checked": checked, "reason": "record count does not match header"}
    return {"valid": True, "records_checked": checked, "last_hash": last_hash}
