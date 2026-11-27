import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import current_user, get_audit_context, require_admin
from app.core.errors import BusinessRuleViolation, NotFound
from app.database.session import get_db
from app.models import Role, User
from app.schemas.audit import AuditLogRead, AuditVerifyResult
from app.schemas.auth import UserRead
from app.schemas.common import Page
from app.schemas.users import AdminUserUpdate, MaintenanceUpdate
from app.services.audit_service import AuditContext, AuditService, export_lines
from app.services.auth_service import AuthService

router = APIRouter(prefix="/admin", tags=["admin"], dependencies=[Depends(require_admin)])


@router.get("/users", response_model=Page[UserRead])
async def list_users(limit: int = Query(50, ge=1, le=200), offset: int = Query(0, ge=0),
                     db: AsyncSession = Depends(get_db)):
    total = await db.scalar(select(func.count()).select_from(User))
    rows = await db.scalars(select(User).order_by(User.created_at).limit(limit).offset(offset))
    return Page(items=list(rows), total=int(total or 0), limit=limit, offset=offset)


@router.patch("/users/{user_id}", response_model=UserRead)
async def update_user(
    user_id: uuid.UUID, data: AdminUserUpdate,
    admin: User = Depends(require_admin), ctx: AuditContext = Depends(get_audit_context),
    db: AsyncSession = Depends(get_db),
):
    target = await db.get(User, user_id)
    if target is None:
        raise NotFound("User not found")
    if target.id == admin.id and (data.role == "user" or data.is_active is False or data.reset_mfa):
        raise BusinessRuleViolation(
            "Administrators cannot demote, disable or reset two-factor authentication for themselves")
    changes: dict = {}
    if data.role is not None and data.role != target.role_name:
        target.role_id = (await db.scalar(select(Role.id).where(Role.name == data.role)))
        changes["role"] = data.role
    if data.is_active is not None and data.is_active != target.is_active:
        target.is_active = data.is_active
        changes["is_active"] = data.is_active
    if data.reset_mfa and target.mfa_enabled:
        AuthService._clear_mfa(target)
        changes["mfa_reset"] = True
    if changes:
        # Role or status changes invalidate existing sessions (claims would be stale).
        await AuthService(db).revoke_all_for_user(target.id, "admin_update")
        await AuditService(db).record(ctx, "admin.user.update", resource_type="user",
                                      resource_id=target.id, details=changes)
    await db.commit()
    await db.refresh(target, ["role"])
    return target


@router.get("/audit", response_model=Page[AuditLogRead])
async def list_audit(
    limit: int = Query(50, ge=1, le=200), offset: int = Query(0, ge=0),
    action: str | None = Query(None, max_length=64),
    actor_user_id: uuid.UUID | None = None,
    db: AsyncSession = Depends(get_db),
):
    rows, total = await AuditService(db).list(limit=limit, offset=offset, action=action,
                                              actor_user_id=actor_user_id)
    return Page(items=rows, total=total, limit=limit, offset=offset)


@router.get("/audit/export")
async def export_audit(from_id: int = Query(1, ge=1), _: User = Depends(current_user),
                       ctx: AuditContext = Depends(get_audit_context), db: AsyncSession = Depends(get_db)):
    """Download the audit chain as JSON Lines, verifiable offline with
    `python -m app.cli audit-verify-file <file>`. The export itself is audited first."""
    await AuditService(db).record(ctx, "admin.audit.export", details={"from_id": from_id})
    await db.commit()
    body = "".join([line async for line in export_lines(db, from_id)])
    name = f"aurex-audit-{datetime.now(UTC).strftime('%Y%m%dT%H%M%SZ')}.jsonl"
    return Response(body, media_type="application/x-ndjson",
                    headers={"Content-Disposition": f'attachment; filename="{name}"'})


@router.get("/audit/verify", response_model=AuditVerifyResult)
async def verify_audit(db: AsyncSession = Depends(get_db)):
    return await AuditService(db).verify_chain()


@router.post("/maintenance")
async def set_maintenance(data: MaintenanceUpdate, admin: User = Depends(require_admin),
                          ctx: AuditContext = Depends(get_audit_context), db: AsyncSession = Depends(get_db)):
    """Put the whole site on hold (traders locked out, bots and autopilot paused) or bring it back."""
    from app.ops import maintenance
    value = await maintenance.set_state(db, data.enabled, data.message, data.until, admin.id)
    action = "admin.maintenance." + ("on" if data.enabled else "off")
    details = {"message": data.message, "until": value["until"]}
    await AuditService(db).record(ctx, action, resource_type="platform", details=details)
    await db.commit()
    return value
