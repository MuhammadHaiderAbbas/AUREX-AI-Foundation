import uuid
from datetime import UTC, datetime
from decimal import Decimal
from typing import Literal

from fastapi import APIRouter, Depends, Query, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import current_trader, get_audit_context
from app.database.session import get_db
from app.futures import book as obook
from app.futures.service import FuturesRejected, FuturesService, OpenRequest, config, next_funding
from app.futures.signal import futures_signal
from app.models import FuturesPosition, User
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
