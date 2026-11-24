import uuid

from fastapi import APIRouter, Depends, Query, Response, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import current_user, get_audit_context, require_admin
from app.core.errors import NotFound, RateLimited
from app.core.rate_limit import SlidingWindowLimiter
from app.database.session import get_db
from app.models import Execution, Order, OrderEvent, PortfolioSnapshot, Position, RiskDecision, TradingAccount, User
from app.schemas.common import Page
from app.schemas.trading import (
    ClosedPositionRead,
    ExecutionRead,
    OrderCreate,
    OrderDetail,
    OrderEventRead,
    OrderRead,
    PortfolioSummary,
    SnapshotRead,
)
from app.services.audit_service import AuditContext, AuditService
from app.trading.service import OrderRequest, TradingService

router = APIRouter(tags=["trading"])
order_limiter = SlidingWindowLimiter()
ORDERS_PER_MINUTE = 60


async def _owned_account_ids(db: AsyncSession, user: User, account_id: uuid.UUID | None) -> list[uuid.UUID]:
    stmt = select(TradingAccount.id).where(TradingAccount.owner_id == user.id)
    if account_id:
        stmt = stmt.where(TradingAccount.id == account_id)
    ids = list(await db.scalars(stmt))
    if account_id and not ids:
        raise NotFound("Trading account not found")
    return ids


async def _detail(db: AsyncSession, o: Order) -> OrderDetail:
    evs = await db.scalars(select(OrderEvent).where(OrderEvent.order_id == o.id).order_by(OrderEvent.created_at))
    exes = await db.scalars(select(Execution).where(Execution.order_id == o.id))
    decision = await db.scalar(select(RiskDecision).where(RiskDecision.order_id == o.id)
                               .order_by(RiskDecision.created_at.desc()).limit(1))
    children = await db.scalars(select(Order).where(Order.parent_order_id == o.id).order_by(Order.created_at))
    return OrderDetail(**OrderRead.model_validate(o).model_dump(), events=[OrderEventRead.model_validate(e) for e in evs],
                       executions=[ExecutionRead.model_validate(x) for x in exes],
                       risk_checks=decision.checks if decision else [],
                       children=[OrderRead.model_validate(c) for c in children])


@router.post("/trading/orders", response_model=OrderDetail, status_code=status.HTTP_201_CREATED)
async def place_order(data: OrderCreate, response: Response, user: User = Depends(current_user),
                      ctx: AuditContext = Depends(get_audit_context), db: AsyncSession = Depends(get_db)):
    """Submit a paper order. Business rejections are persisted (status REJECTED) for the audit trail."""
    if not order_limiter.hit(str(user.id), ORDERS_PER_MINUTE, 60):
        raise RateLimited("Order rate limit reached")
    svc = TradingService(db)
    order, created = await svc.place(user, OrderRequest(**data.model_dump()))
    if created:
        await AuditService(db).record(ctx, "order.submit", resource_type="order", resource_id=order.id,
                                      details={"symbol": order.symbol, "side": order.side, "type": order.type,
                                               "quantity": str(order.quantity), "status": order.status,
                                               "reason": order.reject_reason,
                                               "stop_loss": str(order.stop_loss) if order.stop_loss else None,
                                               "take_profit": str(order.take_profit) if order.take_profit else None})
    else:
        response.status_code = status.HTTP_200_OK
        response.headers["Idempotent-Replay"] = "true"
    await db.commit()
    return await _detail(db, order)


@router.get("/trading/orders", response_model=Page[OrderRead])
async def list_orders(account_id: uuid.UUID | None = None, status_: str | None = Query(None, alias="status"),
                      limit: int = Query(50, ge=1, le=200), offset: int = Query(0, ge=0),
                      user: User = Depends(current_user), db: AsyncSession = Depends(get_db)):
    ids = await _owned_account_ids(db, user, account_id)
    base = select(Order).where(Order.account_id.in_(ids))
    if status_:
        base = base.where(Order.status == status_)
    total = await db.scalar(select(func.count()).select_from(base.subquery()))
    rows = await db.scalars(base.order_by(Order.created_at.desc()).limit(limit).offset(offset))
    return Page(items=[OrderRead.model_validate(o) for o in rows], total=int(total or 0), limit=limit, offset=offset)


@router.get("/trading/orders/{order_id}", response_model=OrderDetail)
async def get_order(order_id: uuid.UUID, user: User = Depends(current_user), db: AsyncSession = Depends(get_db)):
    o = await db.get(Order, order_id)
    if o is None or o.user_id != user.id:
        raise NotFound("Order not found")
    return await _detail(db, o)


@router.post("/trading/orders/{order_id}/cancel", response_model=OrderDetail)
async def cancel_order(order_id: uuid.UUID, user: User = Depends(current_user),
                       ctx: AuditContext = Depends(get_audit_context), db: AsyncSession = Depends(get_db)):
    o = await TradingService(db).cancel(user, order_id)
    await AuditService(db).record(ctx, "order.cancel", resource_type="order", resource_id=o.id)
    await db.commit()
    return await _detail(db, o)


@router.get("/trading/executions", response_model=Page[ExecutionRead])
async def list_executions(account_id: uuid.UUID | None = None, limit: int = Query(50, ge=1, le=200),
                          offset: int = Query(0, ge=0), user: User = Depends(current_user),
                          db: AsyncSession = Depends(get_db)):
    ids = await _owned_account_ids(db, user, account_id)
    base = select(Execution).where(Execution.account_id.in_(ids))
    total = await db.scalar(select(func.count()).select_from(base.subquery()))
    rows = await db.scalars(base.order_by(Execution.executed_at.desc()).limit(limit).offset(offset))
    return Page(items=[ExecutionRead.model_validate(x) for x in rows], total=int(total or 0), limit=limit, offset=offset)


@router.get("/trading/positions/closed", response_model=list[ClosedPositionRead])
async def closed_positions(account_id: uuid.UUID, user: User = Depends(current_user), db: AsyncSession = Depends(get_db)):
    ids = await _owned_account_ids(db, user, account_id)
    rows = await db.scalars(select(Position).where(Position.account_id.in_(ids), Position.status == "CLOSED")
                            .order_by(Position.closed_at.desc()).limit(100))
    return list(rows)


@router.post("/trading/process", dependencies=[Depends(require_admin)])
async def process_orders(db: AsyncSession = Depends(get_db)):
    """Run one pass of the order matcher (it also runs in the background)."""
    stats = await TradingService(db).process_open()
    await db.commit()
    return stats


@router.get("/portfolio/summary", response_model=PortfolioSummary)
async def portfolio_summary(account_id: uuid.UUID, user: User = Depends(current_user), db: AsyncSession = Depends(get_db)):
    svc = TradingService(db)
    acct = await svc._account(user, account_id)
    out = await svc.summary(acct)
    await db.commit()
    return out


@router.get("/portfolio/history", response_model=list[SnapshotRead])
async def portfolio_history(account_id: uuid.UUID, user: User = Depends(current_user), db: AsyncSession = Depends(get_db)):
    await _owned_account_ids(db, user, account_id)
    rows = await db.scalars(select(PortfolioSnapshot).where(PortfolioSnapshot.account_id == account_id)
                            .order_by(PortfolioSnapshot.taken_at).limit(2000))
    return list(rows)
