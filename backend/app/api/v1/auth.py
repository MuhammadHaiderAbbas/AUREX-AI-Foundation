from fastapi import APIRouter, Depends, Request, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import Principal, audit_context, get_audit_context, get_principal
from app.core.config import get_settings
from app.database.session import get_db
from app.schemas.auth import (
    ChangePasswordRequest,
    LoginRequest,
    RegisterRequest,
    TokenResponse,
    UserRead,
)
from app.services.audit_service import AuditContext
from app.services.auth_service import AuthService, IssuedTokens

router = APIRouter(prefix="/auth", tags=["auth"])


def _set_refresh_cookie(response: Response, token: str) -> None:
    s = get_settings()
    response.set_cookie(
        s.refresh_cookie_name, token,
        max_age=s.refresh_token_ttl_days * 86400,
        httponly=True, secure=s.cookie_secure, samesite="strict",
        path=f"{s.api_prefix}/auth",
    )


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


@router.post("/login", response_model=TokenResponse)
async def login(data: LoginRequest, request: Request, response: Response,
                db: AsyncSession = Depends(get_db)):
    tokens = await AuthService(db).login(data, audit_context(request),
                                         request.headers.get("user-agent"))
    await db.commit()
    return _token_response(response, tokens)


@router.post("/refresh", response_model=TokenResponse)
async def refresh(request: Request, response: Response, db: AsyncSession = Depends(get_db)):
    token = request.cookies.get(get_settings().refresh_cookie_name)
    tokens = await AuthService(db).refresh(token, audit_context(request),
                                           request.headers.get("user-agent"))
    await db.commit()
    return _token_response(response, tokens)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
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
