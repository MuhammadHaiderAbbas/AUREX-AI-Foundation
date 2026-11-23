from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import current_user, get_audit_context
from app.database.session import get_db
from app.models import User, UserSettings
from app.schemas.audit import AuditLogRead
from app.schemas.users import UserSettingsRead, UserSettingsUpdate
from app.services.audit_service import AuditContext, AuditService

router = APIRouter(prefix="/users", tags=["users"])


async def _settings(db: AsyncSession, user: User) -> UserSettings:
    settings = await db.get(UserSettings, user.id)
    if settings is None:
        settings = UserSettings(user_id=user.id)
        db.add(settings)
        await db.flush()
    return settings


@router.get("/me/settings", response_model=UserSettingsRead)
async def get_settings_(user: User = Depends(current_user), db: AsyncSession = Depends(get_db)):
    settings = await _settings(db, user)
    await db.commit()
    return settings


@router.patch("/me/settings", response_model=UserSettingsRead)
async def update_settings(
    data: UserSettingsUpdate,
    user: User = Depends(current_user),
    ctx: AuditContext = Depends(get_audit_context),
    db: AsyncSession = Depends(get_db),
):
    settings = await _settings(db, user)
    changes = data.model_dump(exclude_none=True)
    for k, v in changes.items():
        setattr(settings, k, v)
    if changes:
        await AuditService(db).record(ctx, "user.settings.update", resource_type="user",
                                      resource_id=user.id, details=changes)
    await db.commit()
    await db.refresh(settings)
    return settings


@router.get("/me/activity", response_model=list[AuditLogRead])
async def my_activity(limit: int = Query(20, ge=1, le=100), user: User = Depends(current_user),
                      db: AsyncSession = Depends(get_db)):
    """The caller's own audit events (newest first) for the activity timeline."""
    rows, _ = await AuditService(db).list(limit=limit, offset=0, actor_user_id=user.id)
    return rows
