import json
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import Principal, current_user, get_audit_context, get_principal
from app.core.errors import Forbidden
from app.core.security import verify_password
from app.database.session import get_db
from app.models import (
    BinaryBot,
    BinaryContract,
    Execution,
    FuturesBot,
    Order,
    Position,
    RiskProfile,
    TradingAccount,
    User,
    UserSettings,
)
from app.schemas.audit import AuditLogRead
from app.schemas.auth import UserRead
from app.schemas.users import AccountClose, ProfileUpdate, UserSettingsRead, UserSettingsUpdate
from app.services.audit_service import AuditContext, AuditService
from app.services.auth_service import AuthService

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


@router.patch("/me", response_model=UserRead)
async def update_profile(data: ProfileUpdate, user: User = Depends(current_user), ctx: AuditContext = Depends(get_audit_context),
                         db: AsyncSession = Depends(get_db)):
    """Change your display name."""
    old = user.full_name
    user.full_name = data.full_name
    await AuditService(db).record(ctx, "user.profile.update", resource_type="user", resource_id=user.id,
                                  details={"full_name": {"from": old, "to": data.full_name}})
    await db.commit()
    await db.refresh(user)
    return user


def _row(obj: Any, fields: list[str]) -> dict[str, Any]:
    return {f: getattr(obj, f, None) for f in fields}          # Decimal, UUID and datetime are written as strings


@router.get("/me/export")
async def export_my_data(user: User = Depends(current_user), db: AsyncSession = Depends(get_db)):
    """Everything AUREX holds about you, as one JSON document (data portability)."""
    settings = await _settings(db, user)
    accounts = list(await db.scalars(select(TradingAccount).where(TradingAccount.owner_id == user.id)))
    ids = [a.id for a in accounts]
    async def rows(model, fields):
        return [_row(r, fields) for r in await db.scalars(select(model).where(model.account_id.in_(ids)))] if ids else []
    activity, _ = await AuditService(db).list(limit=1000, offset=0, actor_user_id=user.id)
    body = {
        "exported_at": datetime.now(UTC).isoformat(),
        "profile": {"id": str(user.id), "email": user.email, "full_name": user.full_name, "role": user.role.name,
                    "created_at": user.created_at.isoformat(), "mfa_enabled": user.mfa_enabled},
        "settings": {"timezone": settings.timezone, "base_currency": settings.base_currency},
        "accounts": [_row(a, ["id", "name", "base_currency", "mode", "status", "created_at"]) for a in accounts],
        "orders": await rows(Order, ["id", "account_id", "symbol", "side", "type", "quantity", "limit_price", "stop_price", "status",
                                     "filled_qty", "avg_fill_price", "source", "reject_reason", "created_at"]),
        "executions": await rows(Execution, ["id", "account_id", "order_id", "symbol", "side", "quantity", "price", "fee", "executed_at"]),
        "positions": await rows(Position, ["id", "account_id", "symbol", "quantity", "avg_price", "realised_pnl", "status", "opened_at", "closed_at"]),
        "binary_contracts": await rows(BinaryContract, ["id", "account_id", "symbol", "direction", "stake", "strike", "expiry_seconds",
                                                        "status", "settle_price", "pnl", "source", "opened_at", "settled_at"]),
        "activity": [AuditLogRead.model_validate(a).model_dump(mode="json") for a in activity],
    }
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    return Response(json.dumps(body, indent=2, default=str), media_type="application/json",
                    headers={"Content-Disposition": f'attachment; filename="aurex-my-data-{stamp}.json"'})


@router.post("/me/close", status_code=204)
async def close_my_account(data: AccountClose, principal: Principal = Depends(get_principal),
                           ctx: AuditContext = Depends(get_audit_context), db: AsyncSession = Depends(get_db)):
    """Close your AUREX account. Sign-in stops, personal details are removed and paper accounts, bots and
    autopilot are stopped. Trading records and the audit trail are append-only and kept, attached to an
    anonymous id, so the ledger and audit chain stay verifiable."""
    user = principal.user
    if not verify_password(data.password, user.password_hash):
        raise Forbidden("Password is incorrect", code="invalid_password")
    if user.is_admin:
        raise Forbidden("Administrators cannot close their own account; ask another administrator to disable it")
    ids = list(await db.scalars(select(TradingAccount.id).where(TradingAccount.owner_id == user.id)))
    if ids:
        await db.execute(update(TradingAccount).where(TradingAccount.id.in_(ids)).values(status="CLOSED"))
        await db.execute(update(BinaryBot).where(BinaryBot.account_id.in_(ids)).values(status="STOPPED"))
        await db.execute(update(FuturesBot).where(FuturesBot.account_id.in_(ids)).values(status="STOPPED"))
        await db.execute(update(RiskProfile).where(RiskProfile.account_id.in_(ids)).values(autopilot_status="STOPPED"))
    await AuditService(db).record(ctx, "user.account.close", resource_type="user", resource_id=user.id,
                                  details={"paper_accounts_closed": len(ids)})
    user.is_active = False
    user.email = f"closed-{user.id}@closed.invalid"
    user.full_name = "Closed account"
    user.mfa_enabled, user.mfa_secret_enc, user.mfa_pending_secret_enc, user.mfa_recovery_hashes = False, None, None, None
    await AuthService(db).revoke_all_for_user(user.id, "account_closed")
    await db.commit()
