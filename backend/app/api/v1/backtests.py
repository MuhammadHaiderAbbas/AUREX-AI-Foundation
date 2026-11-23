import uuid

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import current_user, get_audit_context
from app.backtest import strategies as strat
from app.backtest.service import BacktestService
from app.core.errors import NotFound, RateLimited
from app.core.rate_limit import SlidingWindowLimiter
from app.database.session import get_db
from app.models import Backtest, StrategyDef, User
from app.schemas.backtest import BacktestRead, BacktestRequest, BacktestSummary, StrategyRead
from app.schemas.common import Page
from app.services.audit_service import AuditContext, AuditService

router = APIRouter(prefix="/backtests", tags=["backtests"])
bt_limiter = SlidingWindowLimiter()
RUNS_PER_HOUR = 30


@router.get("/strategies", response_model=list[StrategyRead])
async def strategies(_: User = Depends(current_user), db: AsyncSession = Depends(get_db)):
    enabled = {s.key for s in await db.scalars(select(StrategyDef).where(StrategyDef.enabled.is_(True)))}
    return [StrategyRead(key=s.key, name=s.name, description=s.description, defaults=s.defaults, params=s.params,
                         grid_size=len(s.grid)) for s in strat.STRATEGIES.values() if s.key in enabled]


@router.post("", response_model=BacktestRead, status_code=status.HTTP_201_CREATED)
async def run_backtest(data: BacktestRequest, user: User = Depends(current_user),
                       ctx: AuditContext = Depends(get_audit_context), db: AsyncSession = Depends(get_db)):
    """Event-driven backtest with in-sample optimisation and a single out-of-sample evaluation."""
    if not bt_limiter.hit(str(user.id), RUNS_PER_HOUR, 3600):
        raise RateLimited("Backtest limit reached for this hour")
    bt = await BacktestService(db).run(
        user, strategy=data.strategy, symbol=data.symbol, days=data.days, params=data.params,
        optimise=data.optimise, capital=data.capital, cost_overrides=data.costs.model_dump(exclude_none=True))
    await AuditService(db).record(ctx, "backtest.run", resource_type="backtest", resource_id=bt.id,
                                  details={"strategy": bt.strategy_key, "symbol": bt.symbol,
                                           "oos_sharpe": bt.oos_sharpe, "optimised": data.optimise})
    await db.commit()
    return bt


@router.get("", response_model=Page[BacktestSummary])
async def list_backtests(limit: int = Query(30, ge=1, le=100), offset: int = Query(0, ge=0),
                         user: User = Depends(current_user), db: AsyncSession = Depends(get_db)):
    base = select(Backtest).where(Backtest.user_id == user.id)
    total = await db.scalar(select(func.count()).select_from(base.subquery()))
    rows = await db.scalars(base.order_by(Backtest.created_at.desc()).limit(limit).offset(offset))
    return Page(items=[BacktestSummary.model_validate(r) for r in rows], total=int(total or 0),
                limit=limit, offset=offset)


@router.get("/{backtest_id}", response_model=BacktestRead)
async def get_backtest(backtest_id: uuid.UUID, user: User = Depends(current_user), db: AsyncSession = Depends(get_db)):
    bt = await db.get(Backtest, backtest_id)
    if bt is None or bt.user_id != user.id:
        raise NotFound("Backtest not found")
    return bt
