import uuid

from fastapi import APIRouter, Depends, Header, Query, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import current_trader, get_audit_context
from app.database.session import get_db
from app.models import LedgerTransaction, TradingAccount, User
from app.schemas.accounts import (
    AccountBalances,
    BalanceLine,
    CashMovement,
    LedgerEntryRead,
    LedgerTransactionRead,
    PaperAccountCreate,
    TradingAccountRead,
)
from app.schemas.common import Page
from app.services.account_service import AccountService
from app.services.audit_service import AuditContext
from app.services.ledger_service import LedgerService

router = APIRouter(prefix="/accounts", tags=["accounts"])

IdempotencyKey = Header(default=None, alias="Idempotency-Key", min_length=8, max_length=128)


async def _with_balances(db: AsyncSession, accounts: list[TradingAccount]):
    if not accounts:
        return []
    balances = await LedgerService(db).balances([a.id for a in accounts])
    out = []
    for a in accounts:
        summary = LedgerService.summarise(balances[a.id])
        read = TradingAccountRead.model_validate(a)
        read.cash_balance = summary["cash"]
        read.equity = summary["equity"]
        out.append(read)
    return out


def _txn_read(txn: LedgerTransaction) -> LedgerTransactionRead:
    return LedgerTransactionRead(
        id=txn.id, type=txn.type, description=txn.description, created_at=txn.created_at,
        created_by=txn.created_by,
        entries=[LedgerEntryRead(ledger_code=e.ledger_account.code, direction=e.direction,
                                 amount=e.amount, currency=e.currency) for e in txn.entries],
    )


@router.get("", response_model=list[TradingAccountRead])
async def list_accounts(user: User = Depends(current_trader), db: AsyncSession = Depends(get_db)):
    return await _with_balances(db, await AccountService(db).list_for_user(user))


@router.post("", response_model=TradingAccountRead, status_code=status.HTTP_201_CREATED)
async def create_paper_account(
    data: PaperAccountCreate,
    user: User = Depends(current_trader),
    ctx: AuditContext = Depends(get_audit_context),
    db: AsyncSession = Depends(get_db),
):
    account = await AccountService(db).create_paper_account(user, data, ctx)
    await db.commit()
    return (await _with_balances(db, [account]))[0]


@router.get("/{account_id}", response_model=TradingAccountRead)
async def get_account(account_id: uuid.UUID, user: User = Depends(current_trader),
                      db: AsyncSession = Depends(get_db)):
    account = await AccountService(db).get_owned(user, account_id)
    return (await _with_balances(db, [account]))[0]


@router.get("/{account_id}/balances", response_model=AccountBalances)
async def get_balances(account_id: uuid.UUID, user: User = Depends(current_trader),
                       db: AsyncSession = Depends(get_db)):
    account = await AccountService(db).get_owned(user, account_id)
    lines = (await LedgerService(db).balances([account.id]))[account.id]
    summary = LedgerService.summarise(lines)
    return AccountBalances(
        trading_account_id=account.id, currency=account.base_currency,
        lines=[BalanceLine(**{k: v for k, v in ln.items() if not k.startswith("_")})
               for ln in lines],
        **summary,
    )


@router.get("/{account_id}/ledger", response_model=Page[LedgerTransactionRead])
async def get_ledger(
    account_id: uuid.UUID,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    user: User = Depends(current_trader),
    db: AsyncSession = Depends(get_db),
):
    account = await AccountService(db).get_owned(user, account_id)
    txns, total = await LedgerService(db).transactions(account.id, limit=limit, offset=offset)
    return Page(items=[_txn_read(t) for t in txns], total=total, limit=limit, offset=offset)


async def _movement(method, account_id, data, user, ctx, db, key, response):
    txn, created = await method(user, account_id, data, ctx, idempotency_key=key)
    await db.commit()
    response.status_code = status.HTTP_201_CREATED if created else status.HTTP_200_OK
    if not created:
        response.headers["Idempotent-Replay"] = "true"
    return _txn_read(txn)


@router.post("/{account_id}/deposits", response_model=LedgerTransactionRead,
             status_code=status.HTTP_201_CREATED)
async def deposit(
    account_id: uuid.UUID, data: CashMovement, response: Response,
    idempotency_key: str | None = IdempotencyKey,
    user: User = Depends(current_trader), ctx: AuditContext = Depends(get_audit_context),
    db: AsyncSession = Depends(get_db),
):
    """Add *virtual* cash. No real money is ever moved by this platform in Stage 1."""
    return await _movement(AccountService(db).deposit, account_id, data, user, ctx, db,
                           idempotency_key, response)


@router.post("/{account_id}/withdrawals", response_model=LedgerTransactionRead,
             status_code=status.HTTP_201_CREATED)
async def withdraw(
    account_id: uuid.UUID, data: CashMovement, response: Response,
    idempotency_key: str | None = IdempotencyKey,
    user: User = Depends(current_trader), ctx: AuditContext = Depends(get_audit_context),
    db: AsyncSession = Depends(get_db),
):
    """Remove *virtual* cash from a paper account."""
    return await _movement(AccountService(db).withdraw, account_id, data, user, ctx, db,
                           idempotency_key, response)


