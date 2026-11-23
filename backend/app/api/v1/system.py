from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app import __version__
from app.core.config import get_settings
from app.database.session import get_db

router = APIRouter(prefix="/system", tags=["system"])


@router.get("/health")
async def health(db: AsyncSession = Depends(get_db)):
    try:
        await db.execute(text("SELECT 1"))
        db_ok = True
    except Exception:  # noqa: BLE001
        db_ok = False
    body = {"status": "ok" if db_ok else "degraded", "database": "ok" if db_ok else "unavailable"}
    return JSONResponse(body, status_code=200 if db_ok else 503)


@router.get("/info")
async def info():
    s = get_settings()
    return {
        "name": s.app_name,
        "version": __version__,
        "environment": s.environment,
        "trading_mode": "PAPER",
        "live_trading_enabled": s.live_trading_enabled,
        "registration_open": s.allow_registration,
        "supported_currencies": s.supported_currencies,
    }
