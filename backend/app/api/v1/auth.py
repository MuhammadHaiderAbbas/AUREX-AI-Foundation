import uuid
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, Request, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import Principal, audit_context, get_audit_context, get_principal
from app.core.config import get_settings
from app.core.errors import Forbidden
from app.database.session import get_db
from app.schemas.auth import (
    ChangePasswordRequest,
    LoginRequest,
    MfaChallenge,
    MfaCodeRequest,
    MfaPasswordCodeRequest,
    MfaSetupRequest,
    MfaSetupResponse,
    MfaVerifyRequest,
    RecoveryCodes,
    RegisterRequest,
    SessionRead,
    TokenResponse,
    UserRead,
)
from app.services.audit_service import AuditContext
from app.services.auth_service import AuthService, IssuedTokens, MfaRequired

router = APIRouter(prefix="/auth", tags=["auth"])


def require_trusted_origin(request: Request) -> None:
    """Defence in depth for the cookie-authenticated endpoints (refresh, logout).

    The refresh cookie is already SameSite=Strict and scoped to /auth. In addition, a request
    that declares an Origin (browsers always do on POST) must come from this site or a
    configured front-end origin.
    """
    origin = request.headers.get("origin")
    if not origin:
        return   # non-browser clients (curl, server-to-server) don't send Origin
    allowed = {o.rstrip("/") for o in get_settings().cors_origins}
    host = request.headers.get("host", "")
    same_site = urlsplit(origin).netloc == host
    if not same_site and origin.rstrip("/") not in allowed:
        raise Forbidden("Cross-site request refused")


def _set_refresh_cookie(response: Response, token: str) -> None:
    s = get_settings()
    response.set_cookie(
        s.refresh_cookie_name, token,
        max_age=s.refresh_token_ttl_days * 86400,
        httponly=True, secure=s.cookie_secure, samesite="strict",
        path=f"{s.api_prefix}/auth",
    )


async def _open_for(db: AsyncSession, user) -> None:
    """During maintenance only administrators may start or refresh a session."""
    from app.ops import maintenance
    try:
        await maintenance.ensure_open(db, user)
    except Exception:
        await db.rollback()
        raise


def _token_response(response: Response, tokens: IssuedTokens) -> TokenResponse:
    _set_refresh_cookie(response, tokens.refresh_token)
    return TokenResponse(
        access_token=tokens.access_token, expires_in=tokens.expires_in,
        user=UserRead.model_validate(tokens.user),
    )


@router.post("/register", response_model=UserRead, status_code=status.HTTP_201_CREATED)
async def register(data: RegisterRequest, request: Request, db: AsyncSession = Depends(get_db)):
    user = await AuthService(db).register(data, audit_context(request))
    await db.commit()
    return user


@router.post("/login", response_model=TokenResponse | MfaChallenge)
async def login(data: LoginRequest, request: Request, response: Response,
                db: AsyncSession = Depends(get_db)):
    """Tokens, or — for accounts with two-factor authentication — an MFA challenge to
    complete at /auth/mfa/verify. No session exists until the second factor is verified."""
    result = await AuthService(db).login(data, audit_context(request), request.headers.get("user-agent"))
    if not isinstance(result, MfaRequired):
        await _open_for(db, result.user)
    await db.commit()
    if isinstance(result, MfaRequired):
        return MfaChallenge(mfa_token=result.token, expires_in=result.expires_in)
    return _token_response(response, result)


@router.post("/mfa/verify", response_model=TokenResponse)
async def mfa_verify(data: MfaVerifyRequest, request: Request, response: Response, db: AsyncSession = Depends(get_db)):
    tokens = await AuthService(db).mfa_verify(data.mfa_token, data.code, audit_context(request),
                                              request.headers.get("user-agent"))
    await _open_for(db, tokens.user)
    await db.commit()
    return _token_response(response, tokens)


@router.post("/mfa/setup", response_model=MfaSetupResponse)
async def mfa_setup(data: MfaSetupRequest, principal: Principal = Depends(get_principal),
                    ctx: AuditContext = Depends(get_audit_context), db: AsyncSession = Depends(get_db)):
    """Start enrolment: returns a new secret (shown once) for an authenticator app."""
    out = await AuthService(db).mfa_setup(principal.user, data.password, ctx)
    await db.commit()
    return out


@router.post("/mfa/enable", response_model=RecoveryCodes)
async def mfa_enable(data: MfaCodeRequest, principal: Principal = Depends(get_principal),
                     ctx: AuditContext = Depends(get_audit_context), db: AsyncSession = Depends(get_db)):
    """Confirm enrolment with a first code. Returns single-use recovery codes (shown once)."""
    codes = await AuthService(db).mfa_enable(principal.user, principal.session_id, data.code, ctx)
    await db.commit()
    return RecoveryCodes(recovery_codes=codes)


@router.post("/mfa/disable", status_code=status.HTTP_204_NO_CONTENT)
async def mfa_disable(data: MfaPasswordCodeRequest, principal: Principal = Depends(get_principal),
                      ctx: AuditContext = Depends(get_audit_context), db: AsyncSession = Depends(get_db)):
    await AuthService(db).mfa_disable(principal.user, data.password, data.code, ctx)
    await db.commit()


@router.post("/mfa/recovery-codes", response_model=RecoveryCodes)
async def mfa_recovery_codes(data: MfaPasswordCodeRequest, principal: Principal = Depends(get_principal),
                             ctx: AuditContext = Depends(get_audit_context), db: AsyncSession = Depends(get_db)):
    codes = await AuthService(db).mfa_regenerate(principal.user, data.password, data.code, ctx)
    await db.commit()
    return RecoveryCodes(recovery_codes=codes)


@router.post("/refresh", response_model=TokenResponse, dependencies=[Depends(require_trusted_origin)])
async def refresh(request: Request, response: Response, db: AsyncSession = Depends(get_db)):
    token = request.cookies.get(get_settings().refresh_cookie_name)
    tokens = await AuthService(db).refresh(token, audit_context(request),
                                           request.headers.get("user-agent"))
    await _open_for(db, tokens.user)
    await db.commit()
    return _token_response(response, tokens)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT, dependencies=[Depends(require_trusted_origin)])
async def logout(request: Request, response: Response, db: AsyncSession = Depends(get_db)):
    s = get_settings()
    await AuthService(db).logout(request.cookies.get(s.refresh_cookie_name),
                                 audit_context(request))
    await db.commit()
    response.delete_cookie(s.refresh_cookie_name, path=f"{s.api_prefix}/auth")
    response.status_code = status.HTTP_204_NO_CONTENT
    return response


@router.get("/me", response_model=UserRead)
async def me(principal: Principal = Depends(get_principal)):
    return principal.user


@router.post("/password", status_code=status.HTTP_204_NO_CONTENT)
async def change_password(
    data: ChangePasswordRequest,
    principal: Principal = Depends(get_principal),
    ctx: AuditContext = Depends(get_audit_context),
    db: AsyncSession = Depends(get_db),
):
    await AuthService(db).change_password(principal.user, principal.session_id, data, ctx)
    await db.commit()


@router.get("/sessions", response_model=list[SessionRead])
async def sessions(principal: Principal = Depends(get_principal), db: AsyncSession = Depends(get_db)):
    """Signed-in sessions (one per device or browser), newest first."""
    return await AuthService(db).sessions(principal.user, principal.session_id)


@router.post("/sessions/{session_id}/revoke", status_code=status.HTTP_204_NO_CONTENT)
async def revoke_session(session_id: uuid.UUID, principal: Principal = Depends(get_principal),
                         ctx: AuditContext = Depends(get_audit_context), db: AsyncSession = Depends(get_db)):
    await AuthService(db).revoke_session(principal.user, session_id, ctx)
    await db.commit()


@router.post("/sessions/revoke-others", status_code=status.HTTP_204_NO_CONTENT)
async def revoke_other_sessions(principal: Principal = Depends(get_principal),
                                ctx: AuditContext = Depends(get_audit_context), db: AsyncSession = Depends(get_db)):
    await AuthService(db).revoke_other_sessions(principal.user, principal.session_id, ctx)
    await db.commit()
