from datetime import datetime
from typing import Literal
from zoneinfo import available_timezones

from pydantic import BaseModel, Field, field_validator

from app.schemas.common import ORMModel


class UserSettingsRead(ORMModel):
    timezone: str
    base_currency: str
    theme: str
    updated_at: datetime


class UserSettingsUpdate(BaseModel):
    timezone: str | None = None
    base_currency: Literal["USD", "GBP", "EUR"] | None = None
    theme: Literal["dark", "light", "system"] | None = None

    @field_validator("timezone")
    @classmethod
    def _tz(cls, v: str | None) -> str | None:
        if v is not None and v not in available_timezones():
            raise ValueError("Unknown IANA timezone")
        return v


class AdminUserUpdate(BaseModel):
    role: Literal["admin", "user"] | None = None
    is_active: bool | None = None
    # Lost device and recovery codes: an administrator can reset two-factor authentication.
    reset_mfa: bool = False


class MaintenanceUpdate(BaseModel):
    enabled: bool
    message: str | None = Field(default=None, max_length=300)
    until: datetime | None = None
