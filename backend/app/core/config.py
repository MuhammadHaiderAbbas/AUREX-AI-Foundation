import json
from functools import lru_cache
from pathlib import Path
from typing import Annotated, Literal

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

_DEV_SECRET = "dev-insecure-change-me-dev-insecure-change-me"  # noqa: S105  # nosec B105 - rejected outside development


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
    # Read the secret from a file (Docker/Kubernetes secrets) instead of the environment.
    jwt_secret_file: str | None = None
    # Rotation: tokens signed with these older secrets still verify until they expire.
    jwt_previous_secrets: Annotated[list[str], NoDecode] = Field(default_factory=list)
    jwt_algorithm: str = "HS256"
    # HMAC key for ML model artifacts. Defaults to a key derived from jwt_secret.
    artifact_key: str | None = None
    artifact_key_file: str | None = None
    # Key for encrypting secrets at rest (TOTP seeds). Defaults to a key derived from jwt_secret.
    data_key: str | None = None
    data_key_file: str | None = None
    access_token_ttl_minutes: int = 15
    refresh_token_ttl_days: int = 7
    refresh_cookie_name: str = "aurex_refresh"
    cookie_secure: bool = False

    allow_registration: bool = True
    # NoDecode: accept plain comma-separated env values instead of requiring JSON.
    cors_origins: Annotated[list[str], NoDecode] = Field(default_factory=lambda: ["http://localhost:5173"])

    login_rate_limit_attempts: int = 5
    login_rate_limit_window_seconds: int = 60
    # Account lockout: failed logins for one email from any IP within the window.
    login_lockout_failures: int = 20
    login_lockout_window_seconds: int = 900
    registrations_per_ip_per_hour: int = 10

    # Transport-level limits (0 disables the rate limit).
    api_rate_limit_per_minute: int = 600
    max_request_bytes: int = 1_048_576          # JSON bodies
    max_upload_bytes: int = 11 * 1_048_576      # research document upload
    # OpenAPI/Swagger UI. None = on in development/test, off in staging/production.
    expose_api_docs: bool | None = None

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

    # Research engine (Phase 4). "extractive" is offline and deterministic; "claude" uses the
    # Anthropic API (credentials from ANTHROPIC_API_KEY / an `ant auth login` profile).
    research_engine: Literal["extractive", "claude"] = "extractive"
    llm_model: str = "claude-opus-5-5"
    llm_effort: Literal["low", "medium", "high", "xhigh", "max"] = "high"
    llm_timeout_seconds: float = 120.0
    research_top_k: int = 8
    research_asks_per_hour: int = 30
    # Hosts that admins may ingest from by URL/RSS. Empty = URL ingestion disabled.
    research_allowed_hosts: Annotated[list[str], NoDecode] = Field(default_factory=list)

    # Paper order matcher: seconds between passes over open LIMIT/STOP orders (0 = disabled).
    order_matcher_interval_seconds: float = 5.0
    # Autopilot: minimum seconds between cycles for an account whose autopilot is RUNNING.
    autopilot_interval_seconds: float = 900.0

    @field_validator("cors_origins", "supported_currencies", "research_allowed_hosts", "jwt_previous_secrets",
                     mode="before")
    @classmethod
    def _split_csv(cls, v: object) -> object:
        if isinstance(v, str):
            if v.lstrip().startswith("["):
                return json.loads(v)
            return [s.strip() for s in v.split(",") if s.strip()]
        return v

    @model_validator(mode="after")
    def _load_secret_files(self) -> "Settings":
        if self.jwt_secret_file:
            self.jwt_secret = Path(self.jwt_secret_file).read_text().strip()
        if self.artifact_key_file:
            self.artifact_key = Path(self.artifact_key_file).read_text().strip()
        if self.data_key_file:
            self.data_key = Path(self.data_key_file).read_text().strip()
        return self

    @model_validator(mode="after")
    def _guard_production(self) -> "Settings":
        if self.environment in ("staging", "production"):
            if self.jwt_secret == _DEV_SECRET or len(self.jwt_secret) < 32:
                raise ValueError("AUREX_JWT_SECRET must be set to a strong value (>=32 chars)")
            if any(s == _DEV_SECRET or len(s) < 32 for s in self.jwt_previous_secrets):
                raise ValueError("AUREX_JWT_PREVIOUS_SECRETS must also be strong (>=32 chars)")
            if self.artifact_key is not None and len(self.artifact_key) < 32:
                raise ValueError("AUREX_ARTIFACT_KEY must be at least 32 characters")
            if self.data_key is not None and len(self.data_key) < 32:
                raise ValueError("AUREX_DATA_KEY must be at least 32 characters")
            if not self.cookie_secure:
                raise ValueError("AUREX_COOKIE_SECURE must be true outside development")
            if "*" in self.cors_origins or any(not o.startswith("https://") for o in self.cors_origins):
                raise ValueError("AUREX_CORS_ORIGINS must list explicit https:// origins outside development")
            if ":aurex@" in self.database_url:
                raise ValueError("AUREX_DATABASE_URL uses the default development password")
        return self

    @property
    def docs_enabled(self) -> bool:
        if self.expose_api_docs is not None:
            return self.expose_api_docs
        return self.environment in ("development", "test")

    @property
    def hsts_enabled(self) -> bool:
        return self.environment in ("staging", "production")

    @property
    def live_trading_enabled(self) -> bool:
        # Hard-wired off for Stage 1. Changing this requires a code change + review,
        # and the database also rejects non-PAPER trading accounts.
        return False


@lru_cache
def get_settings() -> Settings:
    return Settings()
