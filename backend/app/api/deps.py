import uuid
from dataclasses import dataclass

import jwt
from fastapi import Depends, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.errors import Forbidden, Unauthorized
from app.core.security import decode_access_token
from app.database.session import get_db
from app.models import User, UserSession
from app.services.audit_service import AuditContext

bearer = HTTPBearer(auto_error=False)


@dataclass
class Principal:
    user: User
    session_id: uuid.UUID


def audit_context(request: Request) -> AuditContext:
    return AuditContext(
        actor_user_id=getattr(request.state, "user_id", None),
        ip_address=request.client.host if request.client else None,
        request_id=getattr(request.state, "request_id", None),
    )


async def get_principal(
    request: Request,
    creds: HTTPAuthorizationCredentials | None = Depends(bearer),
    db: AsyncSession = Depends(get_db),
) -> Principal:
    if creds is None:
        raise Unauthorized("Authentication required")
    try:
        payload = decode_access_token(creds.credentials)
        user_id = uuid.UUID(payload["sub"])
        session_id = uuid.UUID(payload["sid"])
    except (jwt.PyJWTError, KeyError, ValueError):
        raise Unauthorized("Invalid or expired token")

    # Check the backing session so logout / revocation takes effect immediately.
    row = (await db.execute(
        select(User, UserSession.revoked_at)
        .join(UserSession, UserSession.user_id == User.id)
        .where(User.id == user_id, UserSession.id == session_id)
    )).first()
    if row is None or row[1] is not None:
        raise Unauthorized("Session is no longer valid")
    user: User = row[0]
    if not user.is_active:
        raise Unauthorized("Account disabled")
    request.state.user_id = user.id
    return Principal(user=user, session_id=session_id)


async def current_user(principal: Principal = Depends(get_principal), db: AsyncSession = Depends(get_db)) -> User:
    from app.ops import maintenance
    await maintenance.ensure_open(db, principal.user)
    return principal.user


async def current_trader(user: User = Depends(current_user)) -> User:
    """Trading endpoints: administrators manage the platform and do not trade (separation of duties)."""
    if user.is_admin:
        raise Forbidden("Administrators manage the platform and cannot trade. Sign in with a trader account to trade.",
                        code="admin_cannot_trade")
    return user


async def require_admin(user: User = Depends(current_user)) -> User:
    if not user.is_admin:
        raise Forbidden("Administrator role required")
    if get_settings().admin_mfa_required and not user.mfa_enabled:
        raise Forbidden("Administrators must turn on two-factor authentication (Settings) before using admin functions",
                        code="mfa_required")
    return user


def get_audit_context(request: Request, _: Principal = Depends(get_principal)) -> AuditContext:
    return audit_context(request)
