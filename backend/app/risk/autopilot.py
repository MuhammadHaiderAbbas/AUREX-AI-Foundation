"""AI proposals → paper orders, always through the risk gate; and the autopilot loop.

The agents never talk to the OMS directly: a proposal becomes a MARKET order with a
protective bracket (stop loss + take profit, one-cancels-other) only via `execute_proposal`,
and that order is subject to every risk check a manual order faces.
"""

from datetime import UTC, datetime
from decimal import ROUND_DOWN, ROUND_UP, Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.agents.orchestrator import Orchestrator
from app.core.errors import AppError, BusinessRuleViolation, NotFound
from app.models import (
    AutopilotStatus,
    Instrument,
    Order,
    OrderStatus,
    Position,
    RiskProfile,
    TradeProposal,
    TradingAccount,
    User,
)
from app.risk.service import RiskService
from app.trading.service import OrderRequest, TradingService


async def execute_proposal(db: AsyncSession, user: User, proposal: TradeProposal, source: str = "ai") -> tuple[TradeProposal, Order]:
    if proposal.user_id != user.id:
        raise NotFound("Proposal not found")
    if proposal.status != "PENDING_RISK_REVIEW":
        raise BusinessRuleViolation(f"Proposal is {proposal.status.lower().replace('_', ' ')}")
    if proposal.expires_at <= datetime.now(UTC):
        raise BusinessRuleViolation("Proposal has expired")
    if proposal.direction != "BUY":
        raise BusinessRuleViolation("Only BUY proposals can be executed (spot, no shorting)")
    inst = await db.scalar(select(Instrument).where(Instrument.symbol == proposal.symbol))
    tick = Decimal(1).scaleb(-inst.price_decimals)
    req = OrderRequest(
        account_id=proposal.account_id, symbol=proposal.symbol, side="BUY", type="MARKET",
        quantity=proposal.quantity, client_order_id=f"proposal-{proposal.id.hex}"[:64], source=source,
        stop_loss=proposal.stop_loss.quantize(tick, rounding=ROUND_DOWN),
        take_profit=proposal.take_profit.quantize(tick, rounding=ROUND_UP), proposal_id=proposal.id)
    order, _ = await TradingService(db).place(user, req)
    proposal.decided_at, proposal.order_id = datetime.now(UTC), order.id
    if order.status == OrderStatus.REJECTED:
        proposal.status, proposal.decision_reason = "RISK_REJECTED", order.reject_reason
    else:
        proposal.status, proposal.decision_reason = "EXECUTED", None
    await db.flush()
    return proposal, order


async def run_cycle(db: AsyncSession, acct: TradingAccount, prof: RiskProfile) -> dict[str, Any]:
    """One autopilot pass: analyse each configured symbol and execute approved proposals."""
    risk = RiskService(db)
    user = await db.get(User, acct.owner_id)
    out: dict[str, Any] = {"at": datetime.now(UTC).isoformat(), "results": []}
    block = await risk.block_reason(prof)
    if block:
        out["skipped"] = block
        risk.event(acct.id, "AUTOPILOT_CYCLE", f"Autopilot cycle skipped: {block}")
        prof.autopilot_last_cycle_at = datetime.now(UTC)
        await db.flush()
        return out
    for symbol in prof.autopilot_symbols:
        held = await db.scalar(select(Position.id).where(Position.account_id == acct.id, Position.symbol == symbol,
                                                         Position.status == "OPEN"))
        pending = await db.scalar(select(Order.id).where(Order.account_id == acct.id, Order.symbol == symbol,
                                                         Order.side == "BUY", Order.status == OrderStatus.OPEN).limit(1))
        if held or pending:
            out["results"].append({"symbol": symbol, "outcome": "skipped", "detail": "already positioned"})
            continue
        try:
            run = await Orchestrator(db).run(user, symbol, acct.id)
        except AppError as e:
            out["results"].append({"symbol": symbol, "outcome": "error", "detail": e.message})
            continue
        if run.proposal is None:
            out["results"].append({"symbol": symbol, "outcome": "no_trade", "run_id": str(run.id),
                                   "detail": "; ".join(run.reasons[:2]) or "no proposal"})
            continue
        p, order = await execute_proposal(db, user, run.proposal, source="autopilot")
        out["results"].append({"symbol": symbol, "outcome": "executed" if p.status == "EXECUTED" else "risk_rejected",
                               "run_id": str(run.id), "order_id": str(order.id), "detail": p.decision_reason or order.status})
    prof.autopilot_last_cycle_at = datetime.now(UTC)
    n = sum(r["outcome"] == "executed" for r in out["results"])
    risk.event(acct.id, "AUTOPILOT_CYCLE", f"Autopilot cycle: {len(out['results'])} symbols analysed, {n} orders placed",
               results=out["results"])
    await db.flush()
    return out


async def due_accounts(db: AsyncSession, interval_seconds: float) -> list[TradingAccount]:
    rows = await db.scalars(select(RiskProfile).where(RiskProfile.autopilot_status == AutopilotStatus.RUNNING))
    now = datetime.now(UTC)
    accts = []
    for p in rows:
        if p.autopilot_last_cycle_at is None or (now - p.autopilot_last_cycle_at).total_seconds() >= interval_seconds:
            accts.append(await db.get(TradingAccount, p.account_id))
    return accts
