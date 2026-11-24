import uuid
from datetime import UTC, datetime, timedelta

import jwt
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import crypto, password_policy, totp
from app.core.config import get_settings
from app.core.errors import BusinessRuleViolation, Conflict, Forbidden, NotFound, RateLimited, Unauthorized
from app.core.rate_limit import SlidingWindowLimiter, login_limiter
from app.core.security import (
    MFA_CHALLENGE_TTL,
    create_access_token,
    create_mfa_challenge,
    decode_mfa_challenge,
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


lockout_limiter = SlidingWindowLimiter()       # failed logins per email, any IP
registration_limiter = SlidingWindowLimiter()  # registrations per IP


mfa_limiter = SlidingWindowLimiter()           # second-factor attempts per user

MFA_CONTEXT = "user-mfa-secret"


class MfaRequired:
    def __init__(self, token: str, expires_in: int):
        self.token, self.expires_in = token, expires_in


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
        if not registration_limiter.hit(ctx.ip_address or "?", self.settings.registrations_per_ip_per_hour, 3600):
            raise RateLimited("Too many registrations from this address. Try again later.")
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

        # Account lockout: caps guesses against one account from any number of addresses.
        failures = lockout_limiter.count(email, s.login_lockout_window_seconds)
        if failures >= s.login_lockout_failures:
            raise RateLimited("This account is temporarily locked after repeated failed sign-ins. Try again later.")
        user = await self.db.scalar(select(User).where(User.email == email))
        if not verify_password(data.password, user.password_hash if user else None):
            lockout_limiter.hit(email, 10**9, s.login_lockout_window_seconds)
            if failures + 1 == s.login_lockout_failures:
                await self.audit.record(ctx, "auth.lockout", outcome="failure", resource_type="user",
                                        resource_id=user.id if user else None,
                                        details={"email": email, "failures": failures + 1})
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
        lockout_limiter.reset(email)
        if user.mfa_enabled:
            await self.audit.record(ctx.as_actor(user.id), "auth.mfa.challenge", resource_type="user",
                                    resource_id=user.id)
            return MfaRequired(create_mfa_challenge(user.id), MFA_CHALLENGE_TTL)
        return await self._complete_login(user, ctx, user_agent, method="password")

    async def _complete_login(self, user: User, ctx: AuditContext, user_agent: str | None, method: str) -> IssuedTokens:
        user.last_login_at = datetime.now(UTC)
        tokens = await self._issue(user, ctx, user_agent)
        await self.audit.record(ctx.as_actor(user.id), "auth.login", resource_type="user", resource_id=user.id,
                                details={"method": method})
        return tokens

    # -- two-factor authentication -------------------------------------------------------------
    def _check_second_factor(self, user: User, code: str) -> str | None:
        """'totp' or 'recovery' if the code is valid (consuming recovery codes and TOTP steps)."""
        secret = crypto.decrypt(user.mfa_secret_enc, MFA_CONTEXT) if user.mfa_secret_enc else None
        if secret:
            step = totp.verify(secret, code, last_step=user.mfa_last_step)
            if step is not None:
                user.mfa_last_step = step
                return "totp"
        h = totp.hash_recovery_code(code)
        if user.mfa_recovery_hashes and h in user.mfa_recovery_hashes:
            user.mfa_recovery_hashes = [x for x in user.mfa_recovery_hashes if x != h]
            return "recovery"
        return None

    async def mfa_verify(self, mfa_token: str, code: str, ctx: AuditContext, user_agent: str | None) -> IssuedTokens:
        try:
            user_id = decode_mfa_challenge(mfa_token)
        except (jwt.PyJWTError, ValueError):
            raise Unauthorized("Sign-in step expired. Enter your password again.")
        if not mfa_limiter.hit(str(user_id), 5, 300):
            raise RateLimited("Too many verification attempts. Try again in a few minutes.")
        user = await self.db.scalar(select(User).where(User.id == user_id).with_for_update(of=User))
        if user is None or not user.is_active or not user.mfa_enabled:
            raise Unauthorized("Sign-in step expired. Enter your password again.")
        method = self._check_second_factor(user, code)
        if method is None:
            await self.audit.record(ctx.as_actor(user.id), "auth.mfa.verify", outcome="failure",
                                    resource_type="user", resource_id=user.id)
            await self.db.commit()
            raise Unauthorized("Invalid authentication code")
        mfa_limiter.reset(str(user_id))
        if method == "recovery":
            await self.audit.record(ctx.as_actor(user.id), "auth.mfa.recovery_used", resource_type="user",
                                    resource_id=user.id, details={"remaining": len(user.mfa_recovery_hashes or [])})
        return await self._complete_login(user, ctx, user_agent, method=f"password+{method}")

    async def mfa_setup(self, user: User, password: str, ctx: AuditContext) -> dict:
        if not verify_password(password, user.password_hash):
            raise Unauthorized("Password is incorrect")
        if user.mfa_enabled:
            raise BusinessRuleViolation("Two-factor authentication is already enabled")
        secret = totp.new_secret()
        user.mfa_pending_secret_enc = crypto.encrypt(secret, MFA_CONTEXT)
        await self.audit.record(ctx, "auth.mfa.setup", resource_type="user", resource_id=user.id)
        return {"secret": secret, "otpauth_uri": totp.otpauth_uri(secret, user.email)}

    async def mfa_enable(self, user: User, session_id: uuid.UUID, code: str, ctx: AuditContext) -> list[str]:
        if user.mfa_enabled:
            raise BusinessRuleViolation("Two-factor authentication is already enabled")
        if not user.mfa_pending_secret_enc:
            raise BusinessRuleViolation("Start the setup first")
        secret = crypto.decrypt(user.mfa_pending_secret_enc, MFA_CONTEXT)
        step = totp.verify(secret, code)
        if step is None:
            raise BusinessRuleViolation("That code is not valid. Check the time on your device and try again.")
        codes = totp.new_recovery_codes()
        user.mfa_secret_enc, user.mfa_pending_secret_enc = crypto.encrypt(secret, MFA_CONTEXT), None
        user.mfa_enabled, user.mfa_enabled_at, user.mfa_last_step = True, datetime.now(UTC), step
        user.mfa_recovery_hashes = [totp.hash_recovery_code(c) for c in codes]
        # other sessions were opened with one factor only
        await self.revoke_all_for_user(user.id, "mfa_enabled", keep_session_id=session_id)
        await self.audit.record(ctx, "auth.mfa.enable", resource_type="user", resource_id=user.id)
        return codes

    async def mfa_disable(self, user: User, password: str, code: str, ctx: AuditContext) -> None:
        if not user.mfa_enabled:
            raise BusinessRuleViolation("Two-factor authentication is not enabled")
        if not verify_password(password, user.password_hash) or self._check_second_factor(user, code) is None:
            await self.audit.record(ctx, "auth.mfa.disable", outcome="failure", resource_type="user",
                                    resource_id=user.id)
            await self.db.commit()
            raise Unauthorized("Password or authentication code is incorrect")
        self._clear_mfa(user)
        await self.audit.record(ctx, "auth.mfa.disable", resource_type="user", resource_id=user.id)

    async def mfa_regenerate(self, user: User, password: str, code: str, ctx: AuditContext) -> list[str]:
        if not user.mfa_enabled:
            raise BusinessRuleViolation("Two-factor authentication is not enabled")
        if not verify_password(password, user.password_hash) or self._check_second_factor(user, code) is None:
            raise Unauthorized("Password or authenticator code is incorrect")
        codes = totp.new_recovery_codes()
        user.mfa_recovery_hashes = [totp.hash_recovery_code(c) for c in codes]
        await self.audit.record(ctx, "auth.mfa.recovery_regenerate", resource_type="user", resource_id=user.id)
        return codes

    @staticmethod
    def _clear_mfa(user: User) -> None:
        user.mfa_enabled, user.mfa_secret_enc, user.mfa_pending_secret_enc = False, None, None
        user.mfa_last_step, user.mfa_recovery_hashes, user.mfa_enabled_at = None, None, None

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
        errs = password_policy.problems(data.new_password, email=user.email, name=user.full_name)
        if errs:
            raise BusinessRuleViolation(errs[0])
        if verify_password(data.new_password, user.password_hash):
            raise BusinessRuleViolation("New password must be different from the current one")
        user.password_hash = hash_password(data.new_password)
        await self.revoke_all_for_user(user.id, "password_changed", keep_session_id=session_id)
        await self.audit.record(ctx, "auth.password_change", resource_type="user",
                                resource_id=user.id)

    # -- session management ------------------------------------------------------------------
    async def sessions(self, user: User, current_session_id: uuid.UUID) -> list[dict]:
        now = datetime.now(UTC)
        current = await self.db.get(UserSession, current_session_id)
        rows = list(await self.db.scalars(select(UserSession).where(
            UserSession.user_id == user.id, UserSession.revoked_at.is_(None), UserSession.expires_at > now)
            .order_by(UserSession.created_at.desc())))
        out = []
        for r in rows:
            first = await self.db.scalar(select(func.min(UserSession.created_at))
                                         .where(UserSession.family_id == r.family_id))
            out.append({"id": r.family_id, "signed_in_at": first, "last_active_at": r.created_at,
                        "expires_at": r.expires_at, "ip_address": r.ip_address, "user_agent": r.user_agent,
                        "current": current is not None and r.family_id == current.family_id})
        return out

    async def revoke_session(self, user: User, family_id: uuid.UUID, ctx: AuditContext) -> None:
        owned = await self.db.scalar(select(UserSession.id).where(UserSession.family_id == family_id,
                                                                  UserSession.user_id == user.id).limit(1))
        if owned is None:
            raise NotFound("Session not found")
        await self._revoke_family(family_id, "revoked_by_user")
        await self.audit.record(ctx, "auth.session.revoke", resource_type="user_session", resource_id=family_id)

    async def revoke_other_sessions(self, user: User, current_session_id: uuid.UUID, ctx: AuditContext) -> None:
        await self.revoke_all_for_user(user.id, "revoked_by_user", keep_session_id=current_session_id)
        await self.audit.record(ctx, "auth.session.revoke_others", resource_type="user", resource_id=user.id)
