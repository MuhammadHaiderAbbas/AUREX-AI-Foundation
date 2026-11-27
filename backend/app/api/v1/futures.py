import uuid
from datetime import UTC, datetime
from decimal import Decimal
from typing import Literal

from fastapi import APIRouter, Depends, Query, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import current_trader, get_audit_context
from app.core.errors import BusinessRuleViolation
from app.database.session import get_db
from app.futures import book as obook
from app.futures import bot as fbot
from app.futures.service import FuturesRejected, FuturesService, OpenRequest, config, next_funding
from app.futures.signal import futures_signal
from app.models import FuturesPosition, User
from app.risk.service import RiskService
from app.services.audit_service import AuditContext, AuditService

router = APIRouter(prefix="/futures", tags=["futures"])


class FuturesOpen(BaseModel):
    account_id: uuid.UUID
    symbol: str = Field(min_length=1, max_length=32)
    side: Literal["LONG", "SHORT"]
    margin: Decimal = Field(gt=0, max_digits=20, decimal_places=2)
    leverage: int = Field(ge=1, le=20)
    client_id: str | None = Field(default=None, max_length=64)


@router.get("/config")
async def futures_config(user: User = Depends(current_trader)):
    now = datetime.now(UTC)
    return {**config(), "next_funding_at": next_funding(now)}


@router.get("/book")
async def order_book(symbol: str, depth: int = Query(12, ge=1, le=50), user: User = Depends(current_trader), db: AsyncSession = Depends(get_db)):
    svc = FuturesService(db)
    inst = await svc.instrument(symbol)
    b = await obook.book(svc.market, inst)
    return {"symbol": inst.symbol, "source": b["source"], "bids": [[str(p), str(q)] for p, q in b["bids"][:depth]],
            "asks": [[str(p), str(q)] for p, q in b["asks"][:depth]]}


@router.get("/preview")
async def preview(account_id: uuid.UUID, symbol: str, side: Literal["LONG", "SHORT"], margin: Decimal = Query(gt=0), leverage: int = Query(ge=1, le=20),
                  user: User = Depends(current_trader), db: AsyncSession = Depends(get_db)):
    svc = FuturesService(db)
    acct = await svc.trading._account(user, account_id)
    return await svc.preview(acct, symbol, side, margin.quantize(Decimal("0.01")), leverage)


@router.post("/positions", status_code=status.HTTP_201_CREATED)
async def open_position(data: FuturesOpen, response: Response, user: User = Depends(current_trader),
                        ctx: AuditContext = Depends(get_audit_context), db: AsyncSession = Depends(get_db)):
    svc = FuturesService(db)
    try:
        pos, meta = await svc.open(user, OpenRequest(data.account_id, data.symbol, data.side, data.margin, data.leverage, data.client_id))
    except FuturesRejected as e:
        await AuditService(db).record(ctx, "futures.open", resource_type="trading_account", resource_id=data.account_id,
                                      outcome="failure", details={"symbol": data.symbol, "side": data.side, "reason": e.message})
        await db.commit()
        raise
    if meta.get("idempotent"):
        response.status_code = status.HTTP_200_OK
    else:
        await AuditService(db).record(ctx, "futures.open", resource_type="futures_position", resource_id=pos.id,
                                      details={"symbol": pos.symbol, "side": pos.side, "leverage": pos.leverage, "margin": str(pos.margin),
                                               "entry": str(pos.entry_price), "liquidation": str(pos.liquidation_price)})
    out = await svc.read(pos)
    await db.commit()
    return {**out, "checks": meta.get("checks", [])}


@router.post("/positions/{position_id}/close")
async def close_position(position_id: uuid.UUID, user: User = Depends(current_trader), ctx: AuditContext = Depends(get_audit_context),
                         db: AsyncSession = Depends(get_db)):
    svc = FuturesService(db)
    pos = await svc.close(user, position_id)
    await AuditService(db).record(ctx, "futures.close", resource_type="futures_position", resource_id=pos.id,
                                  details={"exit": str(pos.exit_price), "pnl": str(pos.realised_pnl)})
    out = await svc.read(pos)
    await db.commit()
    return out


@router.get("/positions")
async def list_positions(account_id: uuid.UUID, status_: str | None = Query(None, alias="status"), user: User = Depends(current_trader),
                         db: AsyncSession = Depends(get_db)):
    svc = FuturesService(db)
    acct = await svc.trading._account(user, account_id)
    stmt = select(FuturesPosition).where(FuturesPosition.account_id == acct.id)
    if status_ == "open":
        stmt = stmt.where(FuturesPosition.status == "OPEN")
    elif status_ == "closed":
        stmt = stmt.where(FuturesPosition.status != "OPEN")
    rows = list(await db.scalars(stmt.order_by(FuturesPosition.opened_at.desc()).limit(100)))
    return [await svc.read(p, acct) for p in rows]


@router.get("/signal")
async def signal(symbol: str, user: User = Depends(current_trader), db: AsyncSession = Depends(get_db)):
    svc = FuturesService(db)
    await svc.instrument(symbol)
    return await futures_signal(svc.market, symbol)


# -- the automatic futures bot -----------------------------------------------------------------
class FuturesBotControl(BaseModel):
    account_id: uuid.UUID
    action: Literal["start", "pause", "stop"]
    symbols: list[str] | None = Field(default=None, min_length=1, max_length=4)
    margin_pct: float | None = Field(default=None, gt=0, le=20)
    max_leverage: int | None = Field(default=None, ge=1, le=10)


async def _bot_read(db: AsyncSession, account_id: uuid.UUID) -> dict:
    bot = await fbot.get_bot(db, account_id)
    return {"account_id": bot.account_id, "status": bot.status, "symbols": bot.symbols, "margin_pct": bot.margin_pct,
            "max_leverage": bot.max_leverage, "started_at": bot.started_at, "last_cycle_at": bot.last_cycle_at,
            "paused_reason": bot.paused_reason, "interval_seconds": fbot.interval(), "horizon_hours": fbot.HORIZON,
            "stats": await fbot.bot_stats(db, bot), "recent": await fbot.recent_cycles(db, account_id)}


@router.get("/bot")
async def get_futures_bot(account_id: uuid.UUID, user: User = Depends(current_trader), db: AsyncSession = Depends(get_db)):
    acct = await FuturesService(db).trading._account(user, account_id)
    out = await _bot_read(db, acct.id)
    await db.commit()
    return out


@router.post("/bot")
async def control_futures_bot(data: FuturesBotControl, user: User = Depends(current_trader), ctx: AuditContext = Depends(get_audit_context),
                              db: AsyncSession = Depends(get_db)):
    """Start, pause or stop the bot (start may also change its settings). Starting runs a first cycle at once."""
    svc = FuturesService(db)
    acct = await svc.trading._account(user, data.account_id)
    bot = await fbot.get_bot(db, acct.id, lock=True)
    if data.symbols is not None:
        bot.symbols = list(dict.fromkeys([(await svc.instrument(s)).symbol for s in data.symbols]))
    if data.margin_pct is not None:
        bot.margin_pct = data.margin_pct
    if data.max_leverage is not None:
        bot.max_leverage = min(data.max_leverage, config()["max_leverage"])
    old = bot.status
    if data.action == "start":
        bot.status, bot.paused_reason = "RUNNING", None
        if old == "STOPPED" or bot.started_at is None:
            bot.started_at = datetime.now(UTC)
    else:
        bot.status = "PAUSED" if data.action == "pause" else "STOPPED"
        bot.paused_reason = "paused by you" if data.action == "pause" else None
    RiskService(db).event(acct.id, "FUTURES_BOT_CONTROL", "Futures bot stopped" if data.action == "stop" else f"Futures bot {data.action}ed",
                          symbols=bot.symbols)
    await AuditService(db).record(ctx, f"futures.bot.{data.action}", resource_type="trading_account", resource_id=acct.id,
                                  details={"symbols": bot.symbols, "margin_pct": bot.margin_pct, "max_leverage": bot.max_leverage})
    if data.action == "start":
        await fbot.run_bot_cycle(db, acct, bot)
    out = await _bot_read(db, acct.id)
    await db.commit()
    return out


@router.post("/bot/run")
async def run_futures_bot(account_id: uuid.UUID, user: User = Depends(current_trader), db: AsyncSession = Depends(get_db)):
    """Run one cycle now (the worker also runs it every 15 minutes)."""
    acct = await FuturesService(db).trading._account(user, account_id)
    bot = await fbot.get_bot(db, acct.id, lock=True)
    if bot.status != "RUNNING":
        raise BusinessRuleViolation("Start the bot first")
    out = await fbot.run_bot_cycle(db, acct, bot)
    await db.commit()
    return out
