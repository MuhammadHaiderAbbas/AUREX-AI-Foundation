"""Analytics API (read-only): performance, trades, execution quality, risk, AI quality, reports, exports."""

import csv
import io
import json
import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, Query
from fastapi.responses import Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.analytics.service import AnalyticsService, period_start
from app.api.deps import current_user, get_audit_context
from app.core.errors import NotFound
from app.database.session import get_db
from app.models import Execution, Order, PortfolioSnapshot, RiskDecision, User
from app.models.ledger import LedgerAccount, LedgerEntry, LedgerTransaction
from app.services.audit_service import AuditContext, AuditService

router = APIRouter(prefix="/analytics", tags=["analytics"])
Period = Query("30d", pattern="^(7d|30d|90d|365d|all)$")
EXPORTS = ("executions", "orders", "ledger", "trades", "decisions", "equity")


async def _svc(db: AsyncSession, user: User, account_id: uuid.UUID):
    svc = AnalyticsService(db)
    return svc, await svc.trading._account(user, account_id)


@router.get("/accounts/{account_id}/performance")
async def performance(account_id: uuid.UUID, period: str = Period, benchmark: str | None = Query("SPY", max_length=32),
                      user: User = Depends(current_user), db: AsyncSession = Depends(get_db)):
    svc, acct = await _svc(db, user, account_id)
    out = await svc.performance(acct, period, benchmark or None)
    await db.commit()   # benchmark candles may have been back-filled
    return out


@router.get("/accounts/{account_id}/trades")
async def trades(account_id: uuid.UUID, period: str = Period, user: User = Depends(current_user), db: AsyncSession = Depends(get_db)):
    svc, acct = await _svc(db, user, account_id)
    return await svc.trades(acct, period)


@router.get("/accounts/{account_id}/execution")
async def execution(account_id: uuid.UUID, period: str = Period, user: User = Depends(current_user), db: AsyncSession = Depends(get_db)):
    svc, acct = await _svc(db, user, account_id)
    return await svc.execution(acct, period)


@router.get("/accounts/{account_id}/risk")
async def risk(account_id: uuid.UUID, period: str = Period, user: User = Depends(current_user), db: AsyncSession = Depends(get_db)):
    svc, acct = await _svc(db, user, account_id)
    return await svc.risk(acct, period)


@router.get("/accounts/{account_id}/ai")
async def ai(account_id: uuid.UUID, period: str = Period, horizon_hours: int = Query(24, ge=1, le=168),
             user: User = Depends(current_user), db: AsyncSession = Depends(get_db)):
    svc, acct = await _svc(db, user, account_id)
    out = await svc.ai(acct, period, horizon_hours)
    await db.commit()
    return out


@router.get("/accounts/{account_id}/report")
async def report(account_id: uuid.UUID, period: str = Period, download: bool = False, user: User = Depends(current_user),
                 ctx: AuditContext = Depends(get_audit_context), db: AsyncSession = Depends(get_db)):
    """The full report as JSON, with a SHA-256 of its content. `download=true` returns it as a file."""
    svc, acct = await _svc(db, user, account_id)
    out = await svc.report(acct, period, user.email)
    await AuditService(db).record(ctx, "analytics.report", resource_type="trading_account", resource_id=acct.id,
                                  details={"period": period, "sha256": out["sha256"]})
    await db.commit()
    if not download:
        return out
    name = f"aurex-report-{acct.name.replace(' ', '_')[:30]}-{period}-{datetime.now().strftime('%Y%m%d')}.json"
    return Response(json.dumps(out, indent=2, default=str), media_type="application/json",
                    headers={"Content-Disposition": f'attachment; filename="{name}"'})


def _csv(header: list[str], rows: list[list]) -> str:
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    w.writerow(header)
    for r in rows:
        # neutralise spreadsheet formula injection in free-text cells
        w.writerow([("'" + c) if isinstance(c, str) and c[:1] in ("=", "+", "-", "@") and not _num(c) else c for c in r])
    return buf.getvalue()


def _num(s: str) -> bool:
    try:
        float(s)
        return True
    except ValueError:
        return False


@router.get("/accounts/{account_id}/export/{kind}.csv")
async def export(account_id: uuid.UUID, kind: str, period: str = Period, user: User = Depends(current_user),
                 ctx: AuditContext = Depends(get_audit_context), db: AsyncSession = Depends(get_db)):
    if kind not in EXPORTS:
        raise NotFound(f"Unknown export {kind}")
    svc, acct = await _svc(db, user, account_id)
    since = period_start(period, acct.created_at)
    if kind == "executions":
        rows = await db.scalars(select(Execution).where(Execution.account_id == acct.id, Execution.executed_at >= since).order_by(Execution.executed_at))
        header = ["executed_at", "order_id", "symbol", "side", "quantity", "price", "reference_price", "fx_rate", "fee", "spread_cost", "slippage_cost", "realised_pnl", "ledger_transaction_id"]
        data = [[x.executed_at.isoformat(), x.order_id, x.symbol, x.side, x.quantity, x.price, x.reference_price, x.fx_rate, x.fee,
                 x.spread_cost, x.slippage_cost, x.realised_pnl, x.ledger_transaction_id] for x in rows]
    elif kind == "orders":
        rows = await db.scalars(select(Order).where(Order.account_id == acct.id, Order.created_at >= since).order_by(Order.created_at))
        header = ["created_at", "id", "source", "symbol", "side", "type", "quantity", "limit_price", "stop_price", "stop_loss", "take_profit", "status", "avg_fill_price", "reject_reason", "parent_order_id", "proposal_id"]
        data = [[o.created_at.isoformat(), o.id, o.source, o.symbol, o.side, o.type, o.quantity, o.limit_price, o.stop_price, o.stop_loss,
                 o.take_profit, o.status, o.avg_fill_price, o.reject_reason, o.parent_order_id, o.proposal_id] for o in rows]
    elif kind == "ledger":
        rows = await db.execute(select(LedgerTransaction.created_at, LedgerTransaction.id, LedgerTransaction.type, LedgerTransaction.description,
                                       LedgerAccount.code, LedgerEntry.direction, LedgerEntry.amount, LedgerEntry.currency)
                                .join(LedgerEntry, LedgerEntry.transaction_id == LedgerTransaction.id)
                                .join(LedgerAccount, LedgerAccount.id == LedgerEntry.ledger_account_id)
                                .where(LedgerTransaction.trading_account_id == acct.id, LedgerTransaction.created_at >= since)
                                .order_by(LedgerTransaction.created_at, LedgerEntry.direction.desc()))
        header = ["created_at", "transaction_id", "type", "description", "ledger_account", "direction", "amount", "currency"]
        data = [[r[0].isoformat(), *r[1:]] for r in rows]
    elif kind == "trades":
        trips = await svc.round_trips(acct, since)
        header = ["opened_at", "closed_at", "symbol", "asset_class", "opened_by", "exit", "cost", "gross_pnl", "fees", "net_pnl"]
        data = [[t["opened_at"].isoformat(), t["closed_at"].isoformat(), t["symbol"], t["asset_class"], t["source"], t["exit"],
                 round(t["cost"], 8), round(t["gross_pnl"], 8), round(t["fees"], 8), round(t["pnl"], 8)] for t in trips]
    elif kind == "decisions":
        rows = await db.scalars(select(RiskDecision).where(RiskDecision.account_id == acct.id, RiskDecision.created_at >= since).order_by(RiskDecision.created_at))
        header = ["created_at", "order_id", "proposal_id", "source", "symbol", "side", "approved", "reason", "failed_checks"]
        data = [[d.created_at.isoformat(), d.order_id, d.proposal_id, d.source, d.symbol, d.side, d.approved, d.reason,
                 ";".join(c["name"] for c in d.checks if not c["passed"])] for d in rows]
    else:
        rows = await db.scalars(select(PortfolioSnapshot).where(PortfolioSnapshot.account_id == acct.id, PortfolioSnapshot.taken_at >= since).order_by(PortfolioSnapshot.taken_at))
        header = ["taken_at", "cash", "market_value", "equity", "reason"]
        data = [[s.taken_at.isoformat(), s.cash, s.market_value, s.equity, s.reason] for s in rows]
    await AuditService(db).record(ctx, "analytics.export", resource_type="trading_account", resource_id=acct.id,
                                  details={"kind": kind, "period": period, "rows": len(data)})
    await db.commit()
    name = f"aurex-{kind}-{period}-{datetime.now().strftime('%Y%m%d')}.csv"
    return Response(_csv(header, data), media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="{name}"'})
