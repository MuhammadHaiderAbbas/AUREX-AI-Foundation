import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.errors import Conflict, Forbidden, RateLimited, Unauthorized
from app.core.rate_limit import login_limiter
from app.core.security import (
    create_access_token,
    hash_password,
    hash_token,
    new_refresh_token,
    password_needs_rehash,
    verify_password,
)
from app.models import Role, RoleName, User, UserSession, UserSettings
from app.schemas.auth import ChangePasswordRequest, LoginRequest, RegisterRequest
from app.services.audit_service import AuditContext, AuditService


class IssuedTokens:
    def __init__(self, user: User, access_token: str, expires_in: int, refresh_token: str):
        self.user = user
        self.access_token = access_token
        self.expires_in = expires_in
        self.refresh_token = refresh_token


class AuthService:
    def __init__(self, db: AsyncSession):
        self.db = db
        self.audit = AuditService(db)
        self.settings = get_settings()

    async def _role(self, name: str) -> Role:
        role = await self.db.scalar(select(Role).where(Role.name == name))
        if role is None:  # pragma: no cover - seeded by migration
            raise RuntimeError(f"role {name} missing; run migrations")
        return role

    async def create_user(self, email: str, full_name: str, password: str, role: str) -> User:
        email = email.lower()
        if await self.db.scalar(select(User.id).where(User.email == email)):
            raise Conflict("An account with this email already exists")
        user = User(
            email=email, full_name=full_name, password_hash=hash_password(password),
            role_id=(await self._role(role)).id, is_active=True,
        )
        user.settings = UserSettings()
        self.db.add(user)
        await self.db.flush()
        await self.db.refresh(user, ["role"])
        return user

    async def register(self, data: RegisterRequest, ctx: AuditContext) -> User:
        if not self.settings.allow_registration:
            raise Forbidden("Registration is disabled")
        user = await self.create_user(data.email, data.full_name, data.password, RoleName.USER)
        await self.audit.record(ctx.as_actor(user.id), "auth.register",
                                resource_type="user", resource_id=user.id)
        return user

    async def _issue(self, user: User, ctx: AuditContext, user_agent: str | None,
                     family_id: uuid.UUID | None = None) -> IssuedTokens:
        now = datetime.now(UTC)
        refresh = new_refresh_token()
        session = UserSession(
            user_id=user.id, refresh_token_hash=hash_token(refresh),
            family_id=family_id or uuid.uuid4(), created_at=now,
            expires_at=now + timedelta(days=self.settings.refresh_token_ttl_days),
            ip_address=ctx.ip_address, user_agent=(user_agent or "")[:400] or None,
        )
        self.db.add(session)
        await self.db.flush()
        access, ttl = create_access_token(user.id, user.role_name, session.id)
        return IssuedTokens(user, access, ttl, refresh)

    async def login(self, data: LoginRequest, ctx: AuditContext, user_agent: str | None):
        s = self.settings
        email = data.email.lower()
        key = f"{ctx.ip_address}|{email}"
        if not login_limiter.hit(key, s.login_rate_limit_attempts,
                                 s.login_rate_limit_window_seconds):
            raise RateLimited("Too many login attempts. Try again shortly.")

        user = await self.db.scalar(select(User).where(User.email == email))
        if not verify_password(data.password, user.password_hash if user else None):
            await self.audit.record(ctx, "auth.login", outcome="failure",
                                    resource_type="user",
                                    resource_id=user.id if user else None,
                                    details={"email": email, "reason": "invalid_credentials"})
            await self.db.commit()  # persist the failed-attempt audit record
            raise Unauthorized("Invalid email or password")
        if not user.is_active:
            await self.audit.record(ctx.as_actor(user.id), "auth.login", outcome="failure",
                                    resource_type="user", resource_id=user.id,
                                    details={"reason": "inactive"})
            await self.db.commit()
            raise Forbidden("This account has been disabled")

        if password_needs_rehash(user.password_hash):
            user.password_hash = hash_password(data.password)
        login_limiter.reset(key)
        user.last_login_at = datetime.now(UTC)
        tokens = await self._issue(user, ctx, user_agent)
        await self.audit.record(ctx.as_actor(user.id), "auth.login",
                                resource_type="user", resource_id=user.id)
        return tokens

    async def refresh(self, refresh_token: str | None, ctx: AuditContext,
                      user_agent: str | None) -> IssuedTokens:
        if not refresh_token:
            raise Unauthorized("No refresh token")
        session = await self.db.scalar(
            select(UserSession).where(UserSession.refresh_token_hash == hash_token(refresh_token))
            .with_for_update()
        )
        if session is None:
            raise Unauthorized("Invalid refresh token")
        now = datetime.now(UTC)
        if session.revoked_at is not None:
            if session.revoked_reason == "rotated":
                # A rotated token was replayed: assume theft and kill the whole family.
                await self._revoke_family(session.family_id, "reuse_detected")
                await self.audit.record(ctx.as_actor(session.user_id), "auth.refresh_reuse",
                                        outcome="failure", resource_type="user_session",
                                        resource_id=session.id)
                await self.db.commit()
            raise Unauthorized("Session has been revoked")
        if session.expires_at <= now:
            raise Unauthorized("Session expired")
        user = await self.db.get(User, session.user_id)
        if user is None or not user.is_active:
            raise Unauthorized("Account unavailable")
        session.revoked_at = now
        session.revoked_reason = "rotated"
        return await self._issue(user, ctx, user_agent, family_id=session.family_id)

    async def _revoke_family(self, family_id: uuid.UUID, reason: str) -> None:
        await self.db.execute(
            update(UserSession)
            .where(UserSession.family_id == family_id, UserSession.revoked_at.is_(None))
            .values(revoked_at=datetime.now(UTC), revoked_reason=reason)
        )

    async def revoke_all_for_user(self, user_id: uuid.UUID, reason: str,
                                  keep_session_id: uuid.UUID | None = None) -> None:
        q = update(UserSession).where(
            UserSession.user_id == user_id, UserSession.revoked_at.is_(None)
        )
        if keep_session_id is not None:
            q = q.where(UserSession.id != keep_session_id)
        await self.db.execute(q.values(revoked_at=datetime.now(UTC), revoked_reason=reason))

    async def logout(self, refresh_token: str | None, ctx: AuditContext) -> None:
        if not refresh_token:
            return
        session = await self.db.scalar(
            select(UserSession).where(UserSession.refresh_token_hash == hash_token(refresh_token))
        )
        if session and session.revoked_at is None:
            session.revoked_at = datetime.now(UTC)
            session.revoked_reason = "logout"
            await self.audit.record(ctx.as_actor(session.user_id), "auth.logout",
                                    resource_type="user_session", resource_id=session.id)

    async def change_password(self, user: User, session_id: uuid.UUID,
                              data: ChangePasswordRequest, ctx: AuditContext) -> None:
        if not verify_password(data.current_password, user.password_hash):
            raise Unauthorized("Current password is incorrect")
        user.password_hash = hash_password(data.new_password)
        await self.revoke_all_for_user(user.id, "password_changed", keep_session_id=session_id)
        await self.audit.record(ctx, "auth.password_change", resource_type="user",
                                resource_id=user.id)
