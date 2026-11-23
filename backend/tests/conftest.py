import os

os.environ.setdefault(
    "AUREX_DATABASE_URL", "postgresql+asyncpg://aurex:aurex@localhost:5432/aurex_test"
)
os.environ["AUREX_DATABASE_USE_NULL_POOL"] = "true"
os.environ["AUREX_ENVIRONMENT"] = "test"
os.environ["AUREX_ALLOW_REGISTRATION"] = "true"

from pathlib import Path  # noqa: E402

import httpx  # noqa: E402
import pytest  # noqa: E402
from alembic import command  # noqa: E402
from alembic.config import Config  # noqa: E402
from sqlalchemy import text  # noqa: E402

from app.core.config import get_settings  # noqa: E402
from app.core.rate_limit import login_limiter  # noqa: E402
from app.database.session import SessionLocal  # noqa: E402
from app.main import app  # noqa: E402
from app.models import RoleName  # noqa: E402
from app.services.auth_service import AuthService  # noqa: E402

PASSWORD = "Correct-Horse-42"
BASE_URL = "http://aurex.test"
API = "/api/v1"


@pytest.fixture(scope="session", autouse=True)
def migrated_database():
    cfg = Config(str(Path(__file__).resolve().parents[1] / "alembic.ini"))
    cfg.attributes["configure_logger"] = False
    command.downgrade(cfg, "base")
    command.upgrade(cfg, "head")
    yield


@pytest.fixture(autouse=True)
async def clean_state():
    async with SessionLocal() as db:
        await db.execute(text(
            "TRUNCATE ledger_entries, ledger_transactions, ledger_accounts, trading_accounts, "
            "user_sessions, user_settings, audit_logs, users RESTART IDENTITY CASCADE"
        ))
        await db.commit()
    login_limiter.reset()
    get_settings.cache_clear()
    yield


@pytest.fixture
async def client():
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url=BASE_URL) as c:
        yield c


def new_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url=BASE_URL)


async def register(client, email="trader@example.com", name="Test Trader", password=PASSWORD):
    return await client.post(f"{API}/auth/register",
                             json={"email": email, "full_name": name, "password": password})


async def login(client, email="trader@example.com", password=PASSWORD):
    return await client.post(f"{API}/auth/login", json={"email": email, "password": password})


async def auth_headers(client, email="trader@example.com") -> dict:
    r = await register(client, email=email)
    assert r.status_code == 201, r.text
    r = await login(client, email=email)
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


async def admin_headers(client, email="admin@example.com") -> dict:
    async with SessionLocal() as db:
        await AuthService(db).create_user(email, "Admin", PASSWORD, RoleName.ADMIN)
        await db.commit()
    r = await login(client, email=email)
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}
