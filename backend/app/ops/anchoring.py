"""Audit anchoring: copy the head of the audit hash chain outside the database.

The hash chain proves records were not edited *in place*, but someone with full database
access could rewrite the whole chain consistently, or truncate it. Writing the head
(last record id + its hash) somewhere they cannot reach (a separate append-only volume, an
object store with retention, or another system via a signed webhook) makes that detectable:
`verify_anchors` checks every external anchor still matches the chain.
"""

import asyncio
import hashlib
import hmac
import json
import logging
import os
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.models import AuditAnchor, AuditLog
from app.services.audit_service import AuditContext, AuditService

log = logging.getLogger("aurex.anchor")


def _append(path: Path, line: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(line + "\n")
        f.flush()
        os.fsync(f.fileno())


def sinks_configured() -> list[str]:
    s = get_settings()
    return [n for n, v in (("file", s.audit_anchor_file), ("webhook", s.audit_anchor_webhook_url)) if v]


def sign(body: bytes) -> str:
    return "sha256=" + hmac.new((get_settings().audit_anchor_webhook_secret or "").encode(), body, hashlib.sha256).hexdigest()


async def anchor_now(db: AsyncSession, http: httpx.AsyncClient | None = None, actor=None) -> AuditAnchor:
    """Record the current chain head in every configured sink, then in `audit_anchors`.
    The anchoring itself is audited first, so the anchored head covers it."""
    s = get_settings()
    await AuditService(db).record(AuditContext(actor_user_id=actor), "ops.audit.anchor", details={"sinks": sinks_configured()})
    await db.flush()
    head = await db.scalar(select(AuditLog).order_by(AuditLog.id.desc()).limit(1))
    count = int(await db.scalar(select(func.count()).select_from(AuditLog)) or 0)
    payload = {"type": "aurex-audit-anchor/1", "at": datetime.now(UTC).isoformat(), "last_record_id": head.id,
               "head_hash": head.hash, "records": count, "environment": s.environment}
    line = json.dumps(payload, sort_keys=True)
    results: list[dict[str, Any]] = []
    if s.audit_anchor_file:
        try:
            await asyncio.to_thread(_append, Path(s.audit_anchor_file), line)
            results.append({"sink": "file", "ok": True})
        except OSError as e:
            results.append({"sink": "file", "ok": False, "error": e.__class__.__name__})
    if s.audit_anchor_webhook_url:
        body = line.encode()
        try:
            client = http or httpx.AsyncClient(timeout=10)
            r = await client.post(s.audit_anchor_webhook_url, content=body,
                                  headers={"Content-Type": "application/json", "X-Aurex-Signature": sign(body)})
            results.append({"sink": "webhook", "ok": r.is_success, "status": r.status_code})
            if http is None:
                await client.aclose()
        except httpx.HTTPError as e:
            results.append({"sink": "webhook", "ok": False, "error": e.__class__.__name__})
    anchor = AuditAnchor(last_record_id=head.id, head_hash=head.hash, records=count, sinks=results,
                         created_at=datetime.fromisoformat(payload["at"]))
    db.add(anchor)
    await db.flush()
    if any(not r["ok"] for r in results):
        log.error("audit anchor sink failure: %s", results)
    return anchor


async def last_anchor(db: AsyncSession) -> AuditAnchor | None:
    return await db.scalar(select(AuditAnchor).order_by(AuditAnchor.id.desc()).limit(1))


async def verify_anchors(db: AsyncSession, lines) -> dict[str, Any]:
    """Check external anchor lines (JSONL) against the chain in the database."""
    checked = 0
    for raw in lines:
        if not raw.strip():
            continue
        a = json.loads(raw)
        rec = await db.get(AuditLog, a["last_record_id"])
        if rec is None:
            return {"valid": False, "anchors_checked": checked, "anchor_at": a["at"],
                    "reason": f"audit record {a['last_record_id']} is missing (chain truncated?)"}
        if rec.hash != a["head_hash"]:
            return {"valid": False, "anchors_checked": checked, "anchor_at": a["at"],
                    "reason": f"audit record {a['last_record_id']} no longer has the anchored hash (chain rewritten?)"}
        checked += 1
    return {"valid": True, "anchors_checked": checked}
