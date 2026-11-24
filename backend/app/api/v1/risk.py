"""Risk Centre API: limits, breakers, kill switches, autopilot and the decision log."""

import uuid

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import current_user, get_audit_context, require_admin
from app.core.config import get_settings
from app.core.errors import BusinessRuleViolation, RateLimited
from app.core.rate_limit import SlidingWindowLimiter
from app.database.session import get_db
from app.models import AutopilotStatus, Order, Position, RiskDecision, RiskEvent, User
from app.risk import engine
from app.risk.autopilot import run_cycle
from app.risk.service import RiskService, limits_of
from app.schemas.common import Page
from app.schemas.risk import (
    AutopilotRequest,
    EmergencyStopRequest,
    KillSwitchRequest,
    RiskDecisionRead,
    RiskEventRead,
    RiskLimitsUpdate,
    RiskOverview,
    SystemHalt,
    SystemHaltRequest,
)
from app.services.audit_service import AuditContext, AuditService
from app.trading.service import OrderRequest, TradingService

router = APIRouter(tags=["risk"])
cycle_limiter = SlidingWindowLimiter("autopilot_cycle")
CYCLES_PER_HOUR = 12


async def _overview(db: AsyncSession, user: User, account_id: uuid.UUID) -> RiskOverview:
    ts = TradingService(db)
    acct = await ts._account(user, account_id)
    risk = ts.risk
    prof = await risk.profile(acct.id, lock=True)
    metrics = await risk.metrics(acct, await ts.summary(acct), prof)
    return RiskOverview(
        account_id=acct.id, currency=acct.base_currency, limits=limits_of(prof).__dict__,
        defaults=engine.DEFAULTS, ceilings=engine.CEILINGS,
        state={"kill_switch": prof.kill_switch, "kill_reason": prof.kill_reason, "kill_engaged_at": prof.kill_engaged_at,
               "daily_halted": risk.is_daily_halted(prof), "drawdown_halted": prof.drawdown_halted,
               "drawdown_halted_at": prof.drawdown_halted_at, "blocked_reason": await risk.block_reason(prof)},
        metrics=metrics,
        autopilot={"status": prof.autopilot_status, "symbols": prof.autopilot_symbols,
                   "last_cycle_at": prof.autopilot_last_cycle_at,
                   "interval_seconds": get_settings().autopilot_interval_seconds},
        system=await risk.system_halt())


async def _ctx(db: AsyncSession, user: User, account_id: uuid.UUID):
    ts = TradingService(db)
    acct = await ts._account(user, account_id, lock=True)
    return ts, acct, await ts.risk.profile(acct.id, lock=True)


@router.get("/risk/status", response_model=SystemHalt)
async def system_status(_: User = Depends(current_user), db: AsyncSession = Depends(get_db)):
    return await RiskService(db).system_halt()


@router.get("/risk/accounts/{account_id}", response_model=RiskOverview)
async def overview(account_id: uuid.UUID, user: User = Depends(current_user), db: AsyncSession = Depends(get_db)):
    out = await _overview(db, user, account_id)
    await db.commit()
    return out


@router.put("/risk/accounts/{account_id}/limits", response_model=RiskOverview)
async def update_limits(account_id: uuid.UUID, data: RiskLimitsUpdate, user: User = Depends(current_user),
                        ctx: AuditContext = Depends(get_audit_context), db: AsyncSession = Depends(get_db)):
    ts, acct, prof = await _ctx(db, user, account_id)
    diff = await ts.risk.update_limits(acct, prof, data.model_dump(exclude_none=True), user.id)
    if diff:
        await AuditService(db).record(ctx, "risk.limits.update", resource_type="trading_account", resource_id=acct.id,
                                      details=diff)
    out = await _overview(db, user, account_id)
    await db.commit()
    return out


@router.post("/risk/accounts/{account_id}/kill-switch", response_model=RiskOverview)
async def kill_switch(account_id: uuid.UUID, data: KillSwitchRequest, user: User = Depends(current_user),
                      ctx: AuditContext = Depends(get_audit_context), db: AsyncSession = Depends(get_db)):
    ts, acct, prof = await _ctx(db, user, account_id)
    if data.engaged:
        if prof.kill_switch:
            raise BusinessRuleViolation("Kill switch is already engaged")
        await ts.risk.engage_kill_switch(acct, prof, data.reason or "engaged manually", actor=user.id)
    else:
        await ts.risk.release_kill_switch(acct, prof, actor=user.id)
    await AuditService(db).record(ctx, "risk.kill_switch." + ("engage" if data.engaged else "release"),
                                  resource_type="trading_account", resource_id=acct.id, details={"reason": data.reason})
    out = await _overview(db, user, account_id)
    await db.commit()
    return out


@router.post("/risk/accounts/{account_id}/breakers/drawdown/reset", response_model=RiskOverview)
async def reset_drawdown(account_id: uuid.UUID, user: User = Depends(current_user),
                         ctx: AuditContext = Depends(get_audit_context), db: AsyncSession = Depends(get_db)):
    ts, acct, prof = await _ctx(db, user, account_id)
    await ts.risk.reset_drawdown(acct, prof, await ts.summary(acct, take_snapshot=False), user.id)
    await AuditService(db).record(ctx, "risk.breaker.reset", resource_type="trading_account", resource_id=acct.id)
    out = await _overview(db, user, account_id)
    await db.commit()
    return out


@router.post("/risk/accounts/{account_id}/autopilot", response_model=RiskOverview)
async def autopilot(account_id: uuid.UUID, data: AutopilotRequest, user: User = Depends(current_user),
                    ctx: AuditContext = Depends(get_audit_context), db: AsyncSession = Depends(get_db)):
    ts, acct, prof = await _ctx(db, user, account_id)
    if data.symbols is not None:
        symbols = []
        for sym in data.symbols:
            symbols.append((await ts.market.get(sym)).symbol)
        prof.autopilot_symbols = list(dict.fromkeys(symbols))
    if data.action == "start":
        block = await ts.risk.block_reason(prof)
        if block:
            raise BusinessRuleViolation(f"Autopilot cannot start: {block}")
        if not prof.autopilot_symbols:
            raise BusinessRuleViolation("Choose at least one instrument for the autopilot")
    new = {"start": AutopilotStatus.RUNNING, "pause": AutopilotStatus.PAUSED, "stop": AutopilotStatus.STOPPED}[data.action]
    prof.autopilot_status = new
    ts.risk.event(acct.id, f"AUTOPILOT_{data.action.upper()}", f"Autopilot {data.action}ed" if data.action != "stop" else "Autopilot stopped",
                  actor=user.id, symbols=prof.autopilot_symbols)
    await AuditService(db).record(ctx, f"risk.autopilot.{data.action}", resource_type="trading_account",
                                  resource_id=acct.id, details={"symbols": prof.autopilot_symbols})
    out = await _overview(db, user, account_id)
    await db.commit()
    return out


@router.post("/risk/accounts/{account_id}/autopilot/run")
async def autopilot_run(account_id: uuid.UUID, user: User = Depends(current_user),
                        ctx: AuditContext = Depends(get_audit_context), db: AsyncSession = Depends(get_db)):
    """Run one autopilot cycle now (the background loop also runs it on its interval)."""
    ts, acct, prof = await _ctx(db, user, account_id)
    if prof.autopilot_status != AutopilotStatus.RUNNING:
        raise BusinessRuleViolation("Start the autopilot first")
    if not await cycle_limiter.hit(str(user.id), CYCLES_PER_HOUR, 3600):
        raise RateLimited("Autopilot cycle limit reached for this hour")
    out = await run_cycle(db, acct, prof)
    await AuditService(db).record(ctx, "risk.autopilot.cycle", resource_type="trading_account", resource_id=acct.id,
                                  details={"results": [{k: r.get(k) for k in ("symbol", "outcome")} for r in out["results"]],
                                           "skipped": out.get("skipped")})
    await db.commit()
    return out


@router.post("/risk/accounts/{account_id}/emergency-stop", response_model=RiskOverview)
async def emergency_stop(account_id: uuid.UUID, data: EmergencyStopRequest, user: User = Depends(current_user),
                         ctx: AuditContext = Depends(get_audit_context), db: AsyncSession = Depends(get_db)):
    """Stop the autopilot, engage the kill switch and cancel working entry orders. Protective
    stops stay in place unless `flatten` is set, in which case every position is sold at market."""
    ts, acct, prof = await _ctx(db, user, account_id)
    reason = data.reason or "emergency stop"
    prof.autopilot_status = AutopilotStatus.STOPPED
    if not prof.kill_switch:
        await ts.risk.engage_kill_switch(acct, prof, reason, actor=user.id)
    cancelled = await ts._cancel_where("emergency stop", Order.account_id == acct.id,
                                       or_(Order.side == "BUY", Order.source != "protective"))
    flattened = []
    if data.flatten:
        cancelled += await ts._cancel_where("emergency stop: flattening", Order.account_id == acct.id)
        for pos in list(await db.scalars(select(Position).where(Position.account_id == acct.id, Position.status == "OPEN"))):
            o, _ = await ts.place(user, OrderRequest(account_id=acct.id, symbol=pos.symbol, side="SELL", type="MARKET",
                                                     quantity=pos.quantity, source="emergency"))
            flattened.append({"symbol": pos.symbol, "status": o.status, "reason": o.reject_reason})
    ts.risk.event(acct.id, "EMERGENCY_STOP", f"Emergency stop: {reason}", actor=user.id, cancelled_orders=cancelled,
                  flatten=data.flatten, flattened=flattened)
    await AuditService(db).record(ctx, "risk.emergency_stop", resource_type="trading_account", resource_id=acct.id,
                                  details={"flatten": data.flatten, "cancelled": cancelled, "flattened": flattened})
    out = await _overview(db, user, account_id)
    await db.commit()
    return out


@router.get("/risk/decisions", response_model=Page[RiskDecisionRead])
async def decisions(account_id: uuid.UUID, approved: bool | None = None, limit: int = Query(50, ge=1, le=200),
                    offset: int = Query(0, ge=0), user: User = Depends(current_user), db: AsyncSession = Depends(get_db)):
    await TradingService(db)._account(user, account_id)
    base = select(RiskDecision).where(RiskDecision.account_id == account_id)
    if approved is not None:
        base = base.where(RiskDecision.approved.is_(approved))
    total = await db.scalar(select(func.count()).select_from(base.subquery()))
    rows = await db.scalars(base.order_by(RiskDecision.created_at.desc()).limit(limit).offset(offset))
    return Page(items=[RiskDecisionRead.model_validate(r) for r in rows], total=int(total or 0), limit=limit, offset=offset)


@router.get("/risk/events", response_model=Page[RiskEventRead])
async def events(account_id: uuid.UUID, limit: int = Query(50, ge=1, le=200), offset: int = Query(0, ge=0),
                 user: User = Depends(current_user), db: AsyncSession = Depends(get_db)):
    """The account's risk events plus platform-wide ones (halts)."""
    await TradingService(db)._account(user, account_id)
    base = select(RiskEvent).where(or_(RiskEvent.account_id == account_id, RiskEvent.account_id.is_(None)))
    total = await db.scalar(select(func.count()).select_from(base.subquery()))
    rows = await db.scalars(base.order_by(RiskEvent.created_at.desc()).limit(limit).offset(offset))
    return Page(items=[RiskEventRead.model_validate(r) for r in rows], total=int(total or 0), limit=limit, offset=offset)


@router.post("/admin/risk/halt", response_model=SystemHalt, dependencies=[Depends(require_admin)])
async def system_halt(data: SystemHaltRequest, user: User = Depends(current_user),
                      ctx: AuditContext = Depends(get_audit_context), db: AsyncSession = Depends(get_db)):
    """Platform-wide kill switch: blocks every exposure-increasing order on every account."""
    if data.halted and not data.reason:
        raise BusinessRuleViolation("A reason is required to halt trading")
    out = await RiskService(db).set_system_halt(data.halted, data.reason, user.id)
    await AuditService(db).record(ctx, "risk.system." + ("halt" if data.halted else "resume"), details={"reason": data.reason})
    await db.commit()
    return out

