import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.agents.orchestrator import Orchestrator
from app.api.deps import current_user, get_audit_context, require_admin
from app.core.errors import BusinessRuleViolation, NotFound, RateLimited
from app.core.rate_limit import SlidingWindowLimiter
from app.database.session import get_db
from app.models import AIAgent, AIRun, TradeProposal, User
from app.schemas.ai import AgentRead, AgentUpdate, ProposalRead, RunRead, RunRequest, RunSummary
from app.schemas.common import Page
from app.services.audit_service import AuditContext, AuditService

router = APIRouter(prefix="/ai", tags=["ai"])
run_limiter = SlidingWindowLimiter()
RUNS_PER_HOUR = 60


@router.get("/agents", response_model=list[AgentRead])
async def list_agents(_: User = Depends(current_user), db: AsyncSession = Depends(get_db)):
    rows = await db.scalars(select(AIAgent).order_by(AIAgent.kind.desc(), AIAgent.weight.desc()))
    return list(rows)


@router.patch("/agents/{name}", response_model=AgentRead)
async def update_agent(name: str, data: AgentUpdate, _: User = Depends(require_admin),
                       ctx: AuditContext = Depends(get_audit_context), db: AsyncSession = Depends(get_db)):
    agent = await db.get(AIAgent, name)
    if agent is None:
        raise NotFound("Agent not found")
    if agent.kind == "gate" and (data.enabled is False or data.weight not in (None, 0)):
        raise BusinessRuleViolation("Gate agents (regime, portfolio, risk) cannot be disabled or weighted")
    changes = {k: v for k, v in data.model_dump(exclude_none=True).items() if getattr(agent, k) != v}
    for k, v in changes.items():
        setattr(agent, k, v)
    if changes:
        await AuditService(db).record(ctx, "ai.agent.update", resource_type="ai_agent", resource_id=name,
                                      details=changes)
    await db.commit()
    await db.refresh(agent)
    return agent


@router.post("/run", response_model=RunRead, status_code=status.HTTP_201_CREATED)
async def run_analysis(data: RunRequest, user: User = Depends(current_user),
                       ctx: AuditContext = Depends(get_audit_context), db: AsyncSession = Depends(get_db)):
    """Run the agent department on one instrument. Produces evidence, a decision and, at
    most, a proposal awaiting independent risk review. Never places an order."""
    if not run_limiter.hit(str(user.id), RUNS_PER_HOUR, 3600):
        raise RateLimited("Agent run limit reached for this hour")
    run = await Orchestrator(db).run(user, data.symbol, data.account_id)
    await AuditService(db).record(
        ctx, "ai.run", resource_type="ai_run", resource_id=run.id,
        details={"symbol": run.symbol, "decision": run.decision, "net_score": run.net_score,
                 "proposal": str(run.proposal.id) if run.proposal else None})
    await db.commit()
    return run


@router.get("/runs", response_model=Page[RunSummary])
async def list_runs(symbol: str | None = Query(None, max_length=32), limit: int = Query(20, ge=1, le=100),
                    offset: int = Query(0, ge=0), user: User = Depends(current_user),
                    db: AsyncSession = Depends(get_db)):
    base = select(AIRun).where(AIRun.user_id == user.id)
    if symbol:
        base = base.where(AIRun.symbol == symbol)
    total = await db.scalar(select(func.count()).select_from(base.subquery()))
    rows = await db.scalars(base.order_by(AIRun.created_at.desc()).limit(limit).offset(offset))
    return Page(items=[RunSummary.model_validate(r) for r in rows], total=int(total or 0),
                limit=limit, offset=offset)


@router.get("/runs/{run_id}", response_model=RunRead)
async def get_run(run_id: uuid.UUID, user: User = Depends(current_user), db: AsyncSession = Depends(get_db)):
    run = await db.get(AIRun, run_id)
    if run is None or run.user_id != user.id:
        raise NotFound("Run not found")
    return run


@router.get("/proposals", response_model=Page[ProposalRead])
async def list_proposals(limit: int = Query(20, ge=1, le=100), offset: int = Query(0, ge=0),
                         user: User = Depends(current_user), db: AsyncSession = Depends(get_db)):
    base = select(TradeProposal).where(TradeProposal.user_id == user.id)
    total = await db.scalar(select(func.count()).select_from(base.subquery()))
    rows = await db.scalars(base.order_by(TradeProposal.created_at.desc()).limit(limit).offset(offset))
    return Page(items=[ProposalRead.model_validate(r) for r in rows], total=int(total or 0),
                limit=limit, offset=offset)


@router.post("/proposals/{proposal_id}/dismiss", response_model=ProposalRead)
async def dismiss_proposal(proposal_id: uuid.UUID, user: User = Depends(current_user),
                           ctx: AuditContext = Depends(get_audit_context),
                           db: AsyncSession = Depends(get_db)):
    p = await db.get(TradeProposal, proposal_id)
    if p is None or p.user_id != user.id:
        raise NotFound("Proposal not found")
    if p.status != "PENDING_RISK_REVIEW":
        raise BusinessRuleViolation("Only pending proposals can be dismissed")
    p.status, p.dismissed_at = "DISMISSED", datetime.now(UTC)
    await AuditService(db).record(ctx, "ai.proposal.dismiss", resource_type="trade_proposal",
                                  resource_id=p.id)
    await db.commit()
    await db.refresh(p)
    return p
