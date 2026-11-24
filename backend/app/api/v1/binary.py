"""Paper binary options (fixed-payout HIGHER/LOWER contracts). See app/binary/service.py."""

import uuid

from fastapi import APIRouter, Depends, Query, Response, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import current_user, get_audit_context
from app.api.v1.trading import ORDERS_PER_MINUTE, _owned_account_ids, order_limiter
from app.binary.service import BinaryRejected, BinaryRequest, BinaryService, config
from app.core.errors import RateLimited
from app.database.session import get_db
from app.models import BinaryContract, User
from app.schemas.binary import BinaryConfig, BinaryCreate, BinaryRead, BinaryStats, read
from app.schemas.common import Page
from app.services.audit_service import AuditContext, AuditService

router = APIRouter(tags=["binary"])

NOTICE = ("Paper simulation only. Binary options are banned for retail customers in the UK (FCA, since April 2019) "
          "and restricted across the EU/EEA. The payout is below even money, so a forecaster who is right half "
          "the time loses money; you need to win more often than the break-even rate just to stand still.")


@router.get("/binary/config", response_model=BinaryConfig)
async def binary_config(user: User = Depends(current_user)):
    return {**config(), "notice": NOTICE}


@router.post("/binary/contracts", response_model=BinaryRead, status_code=status.HTTP_201_CREATED)
async def open_contract(data: BinaryCreate, response: Response, user: User = Depends(current_user),
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
                         user: User = Depends(current_user), db: AsyncSession = Depends(get_db)):
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
async def get_contract(contract_id: uuid.UUID, user: User = Depends(current_user), db: AsyncSession = Depends(get_db)):
    svc = BinaryService(db)
    c = await svc.owned(user, contract_id)
    if c.status == "OPEN":
        await svc.settle_due(c.account_id)
        await db.commit()
        await db.refresh(c)
    return read(c)


@router.get("/binary/stats", response_model=BinaryStats)
async def binary_stats(account_id: uuid.UUID, user: User = Depends(current_user), db: AsyncSession = Depends(get_db)):
    svc = BinaryService(db)
    acct = await svc.trading._account(user, account_id)
    await svc.settle_due(acct.id)
    await db.commit()
    return await svc.stats(acct)
