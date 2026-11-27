"""Paper binary options (fixed-payout HIGHER/LOWER contracts). See app/binary/service.py."""

import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, Query, Response, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import current_trader, get_audit_context
from app.api.v1.trading import ORDERS_PER_MINUTE, _owned_account_ids, order_limiter
from app.binary.bot import EXPIRY_BARS, bot_stats, cycle_interval, get_bot, recent_cycles, run_bot_cycle, signal_for
from app.binary.service import BinaryRejected, BinaryRequest, BinaryService, config
from app.core.config import get_settings
from app.core.errors import BusinessRuleViolation, RateLimited
from app.core.rate_limit import SlidingWindowLimiter
from app.database.session import get_db
from app.models import BinaryContract, User
from app.schemas.binary import BinaryConfig, BinaryCreate, BinaryRead, BinaryStats, BotControl, BotRead, read
from app.schemas.common import Page
from app.services.audit_service import AuditContext, AuditService

router = APIRouter(tags=["binary"])
bot_run_limiter = SlidingWindowLimiter("binary_bot_run")
signal_limiter = SlidingWindowLimiter("binary_signal")

NOTICE = ("Paper simulation only. Binary options are banned for retail customers in the UK (FCA, since April 2019) "
          "and restricted across the EU/EEA. The payout is below even money, so a forecaster who is right half "
          "the time loses money; you need to win more often than the break-even rate just to stand still.")


@router.get("/binary/config", response_model=BinaryConfig)
async def binary_config(user: User = Depends(current_trader)):
    return {**config(), "notice": NOTICE}


@router.post("/binary/contracts", response_model=BinaryRead, status_code=status.HTTP_201_CREATED)
async def open_contract(data: BinaryCreate, response: Response, user: User = Depends(current_trader),
                        ctx: AuditContext = Depends(get_audit_context), db: AsyncSession = Depends(get_db)):
    """Open a paper binary contract. Risk rejections are recorded and returned as 422 with the checks."""
    if not await order_limiter.hit(str(user.id), ORDERS_PER_MINUTE, 60):
        raise RateLimited("Order rate limit reached")
    svc = BinaryService(db)
    try:
        c, created = await svc.open(user, BinaryRequest(**data.model_dump()))
    except BinaryRejected as e:
        await AuditService(db).record(ctx, "binary.open", resource_type="trading_account", resource_id=data.account_id,
                                      details={"symbol": data.symbol, "direction": data.direction,
                                               "stake": str(data.stake), "expiry_seconds": data.expiry_seconds,
                                               "status": "REJECTED", "reason": e.message})
        await db.commit()
        raise
    if created:
        await AuditService(db).record(ctx, "binary.open", resource_type="binary_contract", resource_id=c.id,
                                      details={"symbol": c.symbol, "direction": c.direction, "stake": str(c.stake),
                                               "expiry_seconds": c.expiry_seconds, "strike": str(c.strike),
                                               "status": c.status})
    else:
        response.status_code = status.HTTP_200_OK
        response.headers["Idempotent-Replay"] = "true"
    await db.commit()
    return read(c)


@router.get("/binary/contracts", response_model=Page[BinaryRead])
async def list_contracts(account_id: uuid.UUID | None = None, status_: str | None = Query(None, alias="status"),
                         limit: int = Query(50, ge=1, le=200), offset: int = Query(0, ge=0),
                         user: User = Depends(current_trader), db: AsyncSession = Depends(get_db)):
    ids = await _owned_account_ids(db, user, account_id)
    svc = BinaryService(db)
    for aid in ids:                                   # settle anything due before answering
        await svc.settle_due(aid)
    await db.commit()
    base = select(BinaryContract).where(BinaryContract.account_id.in_(ids))
    if status_:
        base = base.where(BinaryContract.status == status_.upper())
    total = await db.scalar(select(func.count()).select_from(base.subquery()))
    rows = await db.scalars(base.order_by(BinaryContract.opened_at.desc()).limit(limit).offset(offset))
    return Page(items=[read(c) for c in rows], total=total or 0, limit=limit, offset=offset)


@router.get("/binary/contracts/{contract_id}", response_model=BinaryRead)
async def get_contract(contract_id: uuid.UUID, user: User = Depends(current_trader), db: AsyncSession = Depends(get_db)):
    svc = BinaryService(db)
    c = await svc.owned(user, contract_id)
    if c.status == "OPEN":
        await svc.settle_due(c.account_id)
        await db.commit()
        await db.refresh(c)
    return read(c)


@router.get("/binary/stats", response_model=BinaryStats)
async def binary_stats(account_id: uuid.UUID, user: User = Depends(current_trader), db: AsyncSession = Depends(get_db)):
    svc = BinaryService(db)
    acct = await svc.trading._account(user, account_id)
    await svc.settle_due(acct.id)
    await db.commit()
    return await svc.stats(acct)


# -- the one-button bot ---------------------------------------------------------------------------
async def _bot_read(db: AsyncSession, account_id: uuid.UUID) -> BotRead:
    bot = await get_bot(db, account_id)
    cfg = config()
    return BotRead(
        account_id=bot.account_id, status=bot.status, symbols=bot.symbols, expiry_seconds=bot.expiry_seconds,
        stake_pct=bot.stake_pct, min_confidence=bot.min_confidence, edge_margin=bot.edge_margin,
        guard_min_contracts=bot.guard_min_contracts, started_at=bot.started_at, last_cycle_at=bot.last_cycle_at,
        paused_reason=bot.paused_reason, interval_seconds=cycle_interval(bot),
        data_mode=get_settings().market_data_mode, break_even_win_rate=cfg["break_even_win_rate"],
        payout_rate=cfg["payout_rate"], stats=await bot_stats(db, bot), recent=await recent_cycles(db, account_id))


@router.get("/binary/bot", response_model=BotRead)
async def get_binary_bot(account_id: uuid.UUID, user: User = Depends(current_trader), db: AsyncSession = Depends(get_db)):
    svc = BinaryService(db)
    acct = await svc.trading._account(user, account_id)
    out = await _bot_read(db, acct.id)
    await db.commit()
    return out


@router.post("/binary/bot", response_model=BotRead)
async def control_binary_bot(data: BotControl, user: User = Depends(current_trader), ctx: AuditContext = Depends(get_audit_context),
                             db: AsyncSession = Depends(get_db)):
    """Start, pause or stop the bot (start may also change its settings). Starting runs a first cycle at once."""
    svc = BinaryService(db)
    acct = await svc.trading._account(user, data.account_id, lock=True)
    bot = await get_bot(db, acct.id, lock=True)
    if data.symbols is not None:
        names = []
        for sym in data.symbols:
            names.append((await svc.market.get(sym)).symbol)
        bot.symbols = list(dict.fromkeys(names))
    if data.expiry_seconds is not None:
        if data.expiry_seconds not in EXPIRY_BARS or data.expiry_seconds not in config()["expiries"]:
            raise BusinessRuleViolation(f"expiry_seconds must be one of {sorted(EXPIRY_BARS)}")
        bot.expiry_seconds = data.expiry_seconds
    for k in ("stake_pct", "min_confidence", "edge_margin"):
        if getattr(data, k) is not None:
            setattr(bot, k, getattr(data, k))
    old = bot.status
    now = datetime.now(UTC)
    if data.action == "start":
        bot.status, bot.paused_reason = "RUNNING", None
        if old == "STOPPED" or bot.started_at is None:
            bot.started_at = now                # a fresh edge-guard window
    else:
        bot.status = "PAUSED" if data.action == "pause" else "STOPPED"
        bot.paused_reason = "paused by you" if data.action == "pause" else None
    svc.risk.event(acct.id, "BINARY_BOT_CONTROL", f"Binary bot {data.action}ed" if data.action != "stop" else "Binary bot stopped",
                   actor=user.id, symbols=bot.symbols, expiry_seconds=bot.expiry_seconds, stake_pct=bot.stake_pct)
    await AuditService(db).record(ctx, f"binary.bot.{data.action}", resource_type="trading_account", resource_id=acct.id,
                                  details={"symbols": bot.symbols, "expiry_seconds": bot.expiry_seconds, "stake_pct": bot.stake_pct,
                                           "min_confidence": bot.min_confidence, "edge_margin": bot.edge_margin})
    if data.action == "start":
        await run_bot_cycle(db, acct, bot)
    await db.flush()
    out = await _bot_read(db, acct.id)
    await db.commit()
    return out


@router.post("/binary/bot/run")
async def run_binary_bot(account_id: uuid.UUID, user: User = Depends(current_trader), db: AsyncSession = Depends(get_db)):
    """Run one bot cycle now (the background worker also runs it every minute)."""
    if not await bot_run_limiter.hit(str(user.id), 12, 60):
        raise RateLimited("Too many manual bot cycles; it also runs on its own every minute")
    svc = BinaryService(db)
    acct = await svc.trading._account(user, account_id, lock=True)
    bot = await get_bot(db, acct.id, lock=True)
    if bot.status != "RUNNING":
        raise BusinessRuleViolation("Start the bot first")
    result = await run_bot_cycle(db, acct, bot)
    await db.commit()
    return result


@router.get("/binary/signal")
async def binary_signal(symbol: str, expiry_seconds: int = Query(300), user: User = Depends(current_trader),
                        db: AsyncSession = Depends(get_db)):
    """What the bot would do right now for one instrument, with its out-of-sample evidence."""
    if expiry_seconds not in EXPIRY_BARS:
        raise BusinessRuleViolation(f"expiry_seconds must be one of {sorted(EXPIRY_BARS)}")
    if not await signal_limiter.hit(str(user.id), 30, 60):
        raise RateLimited("Too many signal requests")
    return await signal_for(db, symbol, expiry_seconds)
