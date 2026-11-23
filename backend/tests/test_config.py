import pytest
from pydantic import ValidationError

from app.core.config import Settings


def test_list_settings_accept_csv_and_json(monkeypatch):
    monkeypatch.setenv("AUREX_CORS_ORIGINS", "http://localhost:8080, https://aurex.example")
    assert Settings().cors_origins == ["http://localhost:8080", "https://aurex.example"]
    monkeypatch.setenv("AUREX_CORS_ORIGINS", '["http://a.example"]')
    assert Settings().cors_origins == ["http://a.example"]


def test_production_requires_strong_secret_and_secure_cookies(monkeypatch):
    monkeypatch.setenv("AUREX_ENVIRONMENT", "production")
    with pytest.raises(ValidationError, match="JWT_SECRET"):
        Settings()
    monkeypatch.setenv("AUREX_JWT_SECRET", "x" * 48)
    with pytest.raises(ValidationError, match="COOKIE_SECURE"):
        Settings()
    monkeypatch.setenv("AUREX_COOKIE_SECURE", "true")
    assert Settings().live_trading_enabled is False
