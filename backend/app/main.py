import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app import __version__
from app.api.router import api_router
from app.core.config import get_settings
from app.core.errors import register_error_handlers
from app.core.middleware import RequestContextMiddleware

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")


log = logging.getLogger("aurex.matcher")


async def _matcher_loop(interval: float) -> None:
    """Background work: fill resting orders, re-value accounts for the breakers, run autopilots."""
    from app.database.session import SessionLocal
    from app.risk.autopilot import due_accounts, run_cycle
    from app.risk.service import RiskService
    from app.trading.service import TradingService

    while True:
        await asyncio.sleep(interval)
        try:
            async with SessionLocal() as db:
                stats = await TradingService(db).process_open()
                await TradingService(db).monitor()
                await db.commit()
            if stats["filled"] or stats["expired"]:
                log.info("order matcher: %s", stats)
            async with SessionLocal() as db:
                for acct in await due_accounts(db, get_settings().autopilot_interval_seconds):
                    prof = await RiskService(db).profile(acct.id, lock=True)
                    out = await run_cycle(db, acct, prof)
                    await db.commit()
                    log.info("autopilot cycle %s: %s", acct.id, [r["outcome"] for r in out["results"]])
        except Exception:  # noqa: BLE001 - the loop must survive transient failures
            log.exception("background trading pass failed")


@asynccontextmanager
async def lifespan(app: FastAPI):
    interval = get_settings().order_matcher_interval_seconds
    task = asyncio.create_task(_matcher_loop(interval)) if interval > 0 else None
    yield
    if task:
        task.cancel()


def create_app() -> FastAPI:
    s = get_settings()
    app = FastAPI(
        lifespan=lifespan,
        title=f"{s.app_name} API",
        version=__version__,
        description=(
            "AUREX AI — autonomous multi-market research & paper-trading platform.\n\n"
            "**Stage 1: paper trading only. Virtual capital; no real money is moved.**"
        ),
        openapi_url=f"{s.api_prefix}/openapi.json",
        docs_url=f"{s.api_prefix}/docs",
        redoc_url=f"{s.api_prefix}/redoc",
    )
    app.add_middleware(RequestContextMiddleware)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=s.cors_origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PATCH", "DELETE"],
        allow_headers=["Authorization", "Content-Type", "Idempotency-Key", "X-Request-ID"],
        expose_headers=["X-Request-ID", "Idempotent-Replay"],
    )
    register_error_handlers(app)
    app.include_router(api_router, prefix=s.api_prefix)
    return app


app = create_app()
