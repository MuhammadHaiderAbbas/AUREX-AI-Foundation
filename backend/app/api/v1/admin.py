import uuid

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_audit_context, require_admin
from app.core.errors import BusinessRuleViolation, NotFound
from app.database.session import get_db
from app.models import Role, User
from app.schemas.audit import AuditLogRead, AuditVerifyResult
from app.schemas.auth import UserRead
from app.schemas.common import Page
from app.schemas.users import AdminUserUpdate
from app.services.audit_service import AuditContext, AuditService
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
    if target.id == admin.id and (data.role == "user" or data.is_active is False):
        raise BusinessRuleViolation("Administrators cannot demote or disable themselves")
    changes: dict = {}
    if data.role is not None and data.role != target.role_name:
        target.role_id = (await db.scalar(select(Role.id).where(Role.name == data.role)))
        changes["role"] = data.role
    if data.is_active is not None and data.is_active != target.is_active:
        target.is_active = data.is_active
        changes["is_active"] = data.is_active
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


@router.get("/audit/verify", response_model=AuditVerifyResult)
async def verify_audit(db: AsyncSession = Depends(get_db)):
    return await AuditService(db).verify_chain()
