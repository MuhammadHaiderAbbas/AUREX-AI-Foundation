import uuid
from datetime import datetime

from pydantic import BaseModel, EmailStr, Field, field_validator, model_validator

from app.core import password_policy
from app.schemas.common import ORMModel


def _validate_password_strength(v: str) -> str:
    return password_policy.validate(v)


class RegisterRequest(BaseModel):
    email: EmailStr
    full_name: str = Field(min_length=1, max_length=200)
    password: str = Field(max_length=256)

    @field_validator("password")
    @classmethod
    def _pw(cls, v: str) -> str:
        return _validate_password_strength(v)

    @field_validator("full_name")
    @classmethod
    def _name(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("Name is required")
        return v

    @model_validator(mode="after")
    def _not_personal(self) -> "RegisterRequest":
        password_policy.validate(self.password, email=str(self.email), name=self.full_name)
        return self


class LoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=256)


class ChangePasswordRequest(BaseModel):
    current_password: str = Field(min_length=1, max_length=256)
    new_password: str = Field(max_length=256)

    @field_validator("new_password")
    @classmethod
    def _pw(cls, v: str) -> str:
        return _validate_password_strength(v)


class UserRead(ORMModel):
    id: uuid.UUID
    email: str
    full_name: str
    role: str = Field(validation_alias="role_name")
    is_active: bool
    created_at: datetime
    last_login_at: datetime | None
    mfa_enabled: bool = False


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"  # noqa: S105
    expires_in: int
    user: UserRead


class SessionRead(BaseModel):
    id: uuid.UUID            # the session family (one per sign-in / device)
    signed_in_at: datetime
    last_active_at: datetime
    expires_at: datetime
    ip_address: str | None
    user_agent: str | None
    current: bool


class MfaChallenge(BaseModel):
    """Returned by /auth/login instead of tokens when the account has two-factor authentication."""
    mfa_required: bool = True
    mfa_token: str
    expires_in: int


class MfaVerifyRequest(BaseModel):
    mfa_token: str = Field(min_length=10, max_length=2000)
    code: str = Field(min_length=6, max_length=32)


class MfaSetupRequest(BaseModel):
    password: str = Field(min_length=1, max_length=256)


class MfaSetupResponse(BaseModel):
    secret: str
    otpauth_uri: str


class MfaCodeRequest(BaseModel):
    code: str = Field(min_length=6, max_length=32)


class MfaPasswordCodeRequest(BaseModel):
    password: str = Field(min_length=1, max_length=256)
    code: str = Field(min_length=6, max_length=32)


class RecoveryCodes(BaseModel):
    recovery_codes: list[str]
