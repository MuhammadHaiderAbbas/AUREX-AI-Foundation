import json
from functools import lru_cache
from typing import Annotated, Literal

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

_DEV_SECRET = "dev-insecure-change-me-dev-insecure-change-me"  # noqa: S105


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="AUREX_", env_file=".env", extra="ignore")

    app_name: str = "AUREX AI"
    environment: Literal["development", "test", "staging", "production"] = "development"
    api_prefix: str = "/api/v1"

    database_url: str = "postgresql+asyncpg://aurex:aurex@localhost:5432/aurex"
    database_echo: bool = False
    # NullPool is used in tests so connections never outlive an event loop.
    database_use_null_pool: bool = False

    jwt_secret: str = _DEV_SECRET
    jwt_algorithm: str = "HS256"
    access_token_ttl_minutes: int = 15
    refresh_token_ttl_days: int = 7
    refresh_cookie_name: str = "aurex_refresh"
    cookie_secure: bool = False

    allow_registration: bool = True
    # NoDecode: accept plain comma-separated env values instead of requiring JSON.
    cors_origins: Annotated[list[str], NoDecode] = Field(default_factory=lambda: ["http://localhost:5173"])

    login_rate_limit_attempts: int = 5
    login_rate_limit_window_seconds: int = 60

    # Paper-trading guard rails (Stage 1: virtual capital only).
    default_starting_balance: str = "100000"
    max_starting_balance: str = "10000000"
    max_paper_accounts_per_user: int = 10
    supported_currencies: Annotated[list[str], NoDecode] = Field(
        default_factory=lambda: ["USD", "GBP", "EUR"]
    )

    # Market data (Phase 3). "synthetic" works offline and is the default; "live" routes
    # crypto to Coinbase and FX to ECB reference rates (stocks/ETFs stay synthetic until
    # a licensed equity feed is configured).
    market_data_mode: Literal["synthetic", "live"] = "synthetic"
    coinbase_base_url: str = "https://api.exchange.coinbase.com"
    frankfurter_base_url: str = "https://api.frankfurter.dev/v1"
    quote_cache_seconds: float = 1.0
    stream_interval_seconds: float = 2.0
    max_stream_symbols: int = 50

    @field_validator("cors_origins", "supported_currencies", mode="before")
    @classmethod
    def _split_csv(cls, v: object) -> object:
        if isinstance(v, str):
            if v.lstrip().startswith("["):
                return json.loads(v)
            return [s.strip() for s in v.split(",") if s.strip()]
        return v

    @model_validator(mode="after")
    def _guard_production(self) -> "Settings":
        if self.environment in ("staging", "production"):
            if self.jwt_secret == _DEV_SECRET or len(self.jwt_secret) < 32:
                raise ValueError("AUREX_JWT_SECRET must be set to a strong value (>=32 chars)")
            if not self.cookie_secure:
                raise ValueError("AUREX_COOKIE_SECURE must be true outside development")
        return self

    @property
    def live_trading_enabled(self) -> bool:
        # Hard-wired off for Stage 1. Changing this requires a code change + review,
        # and the database also rejects non-PAPER trading accounts.
        return False


@lru_cache
def get_settings() -> Settings:
    return Settings()
