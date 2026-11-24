"""Readiness (for load balancers) and the operational status / go-live gates (for admins)."""

from datetime import UTC, datetime
from typing import Any

from redis.exceptions import RedisError
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app import __version__
from app.core.config import get_settings
from app.core.redis import get_redis
from app.models import Role, RoleName, User
from app.ops import anchoring, controls, worker
from app.ops.integrity import alembic_head
from app.services.audit_service import AuditService

ATTESTABLE = {
    "pentest": "External penetration test completed and findings resolved",
    "broker_sandbox": "Broker sandbox integration certified end to end",
}
DRILL_MAX_AGE_DAYS = 30


def _hours(sec: float | None) -> float | None:
    return None if sec is None else round(sec / 3600, 2)


async def readiness(db: AsyncSession) -> tuple[bool, dict[str, Any]]:
    s = get_settings()
    checks: dict[str, Any] = {}
    try:
        await db.execute(text("SELECT 1"))
        checks["database"] = "ok"
    except Exception:  # noqa: BLE001
        return False, {"database": "unavailable"}
    current = await db.scalar(text("SELECT version_num FROM alembic_version"))
    checks["schema"] = "ok" if current == alembic_head() else f"behind ({current})"
    r = get_redis()
    if r is None:
        checks["redis"] = "not configured"
    else:
        try:
            await r.ping()
            checks["redis"] = "ok"
        except (RedisError, OSError):
            checks["redis"] = "unavailable"
    if s.background_worker and s.order_matcher_interval_seconds > 0:
        age = controls.age_seconds(await controls.get(db, controls.HEARTBEAT))
        limit = max(60.0, s.order_matcher_interval_seconds * 6)
        checks["worker"] = "ok" if age is not None and age < limit else ("starting" if age is None else f"stale ({int(age)}s)")
    else:
        checks["worker"] = "disabled in this process"
    ok = checks["schema"] == "ok" and checks["redis"] in ("ok", "not configured") and checks["worker"] in (
        "ok", "disabled in this process", "starting")
    return ok, checks


async def ops_status(db: AsyncSession) -> dict[str, Any]:
    s = get_settings()
    ready, checks = await readiness(db)
    hb = await controls.get(db, controls.HEARTBEAT)
    backup = await controls.get(db, controls.LAST_BACKUP)
    drill = await controls.get(db, controls.LAST_RESTORE_DRILL)
    last = await anchoring.last_anchor(db)
    backup_age = _hours(controls.age_seconds(backup))
    drill_age = _hours(controls.age_seconds(drill))
    anchor_age = _hours((datetime.now(UTC) - last.created_at).total_seconds()) if last else None
    chain = await AuditService(db).verify_chain()
    admins = list(await db.scalars(select(User).join(Role).where(Role.name == RoleName.ADMIN, User.is_active.is_(True))))
    admins_without_mfa = [a.email for a in admins if not a.mfa_enabled]
    attest = {k: await controls.get(db, controls.ATTEST_PREFIX + k) for k in ATTESTABLE}

    def gate(key: str, label: str, ok: bool, detail: str) -> dict[str, Any]:
        return {"key": key, "label": label, "ok": bool(ok), "detail": detail}

    gates = [
        gate("environment", "Running with production settings", s.environment == "production", f"environment = {s.environment}"),
        gate("admin_mfa", "Two-factor authentication enforced for every administrator",
             s.admin_mfa_required and not admins_without_mfa,
             ("enforced" if s.admin_mfa_required else "not enforced") + (f"; without 2FA: {', '.join(admins_without_mfa)}" if admins_without_mfa else "")),
        gate("backups", f"Database backup within {s.max_backup_age_hours:g} h", backup_age is not None and backup_age <= s.max_backup_age_hours,
             f"last backup {backup_age} h ago" if backup_age is not None else "no backup recorded"),
        gate("restore_drill", f"Restore drill passed within {DRILL_MAX_AGE_DAYS} days",
             drill_age is not None and drill_age <= DRILL_MAX_AGE_DAYS * 24 and bool(drill and drill.get("ok")),
             f"last drill {drill_age} h ago ({'passed' if drill and drill.get('ok') else 'failed'})" if drill else "no drill recorded"),
        gate("anchoring", f"Audit head anchored externally within {s.max_anchor_age_hours:g} h",
             bool(anchoring.sinks_configured()) and anchor_age is not None and anchor_age <= s.max_anchor_age_hours,
             (f"sinks: {', '.join(anchoring.sinks_configured()) or 'none'}; last anchor {anchor_age} h ago" if last else
              f"sinks: {', '.join(anchoring.sinks_configured()) or 'none'}; never anchored")),
        gate("monitoring", "Metrics endpoint enabled for monitoring", bool(s.metrics_token), "token configured" if s.metrics_token else "AUREX_METRICS_TOKEN not set"),
        gate("shared_limits", "Rate limits shared across replicas (Redis)", checks["redis"] == "ok", f"redis: {checks['redis']}"),
        gate("audit_chain", "Audit chain intact", chain["valid"], f"{chain['records_checked']} records verified"),
        *[gate(k, label, bool(attest[k]), f"attested {attest[k]['at'][:10]} · {attest[k]['reference']}" if attest[k] else "not attested")
          for k, label in ATTESTABLE.items()],
    ]
    return {
        "version": __version__, "environment": s.environment, "ready": ready, "checks": checks,
        "worker": {"leader_instance": (hb or {}).get("instance"), "heartbeat_age_seconds": controls.age_seconds(hb),
                   "passes": (hb or {}).get("passes"), "last_error": (hb or {}).get("last_error"),
                   "this_process": worker.INSTANCE, "this_process_is_leader": worker.lease.held},
        "backup": {**(backup or {}), "age_hours": backup_age}, "restore_drill": {**(drill or {}), "age_hours": drill_age},
        "anchoring": {"sinks": anchoring.sinks_configured(), "last": None if last is None else {
            "at": last.created_at.isoformat(), "last_record_id": last.last_record_id, "head_hash": last.head_hash,
            "records": last.records, "sinks": last.sinks, "age_hours": anchor_age}},
        "gates": gates, "gates_met": sum(g["ok"] for g in gates), "gates_total": len(gates),
        # Stage 1 invariant: never true. Enabling live trading is a reviewed code change, not a setting.
        "live_trading_enabled": s.live_trading_enabled,
        "users": {"total": await db.scalar(select(func.count()).select_from(User)), "admins": len(admins)},
    }
