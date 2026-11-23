import uuid
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.errors import BusinessRuleViolation, Conflict, NotFound
from app.models import AccountMode, AccountStatus, LedgerTransaction, TradingAccount, User
from app.models.ledger import Direction, LedgerCode, TransactionType
from app.schemas.accounts import CashMovement, PaperAccountCreate
from app.services.audit_service import AuditContext, AuditService
from app.services.ledger_service import LedgerService, Posting


class AccountService:
    def __init__(self, db: AsyncSession):
        self.db = db
        self.ledger = LedgerService(db)
        self.audit = AuditService(db)
        self.settings = get_settings()

    async def list_for_user(self, user: User) -> list[TradingAccount]:
        rows = await self.db.scalars(
            select(TradingAccount)
            .where(TradingAccount.owner_id == user.id)
            .order_by(TradingAccount.created_at)
        )
        return list(rows)

    async def get_owned(
        self, user: User, account_id: uuid.UUID, *, for_update: bool = False
    ) -> TradingAccount:
        q = select(TradingAccount).where(
            TradingAccount.id == account_id, TradingAccount.owner_id == user.id
        )
        if for_update:
            q = q.with_for_update()
        account = await self.db.scalar(q)
        if account is None:
            raise NotFound("Trading account not found")
        return account

    async def create_paper_account(
        self, user: User, data: PaperAccountCreate, ctx: AuditContext
    ) -> TradingAccount:
        s = self.settings
        if data.base_currency not in s.supported_currencies:
            raise BusinessRuleViolation(
                f"Unsupported currency. Supported: {', '.join(s.supported_currencies)}"
            )
        starting = data.starting_balance or Decimal(s.default_starting_balance)
        if starting > Decimal(s.max_starting_balance):
            raise BusinessRuleViolation(
                f"Starting balance exceeds the virtual maximum of {s.max_starting_balance}"
            )
        count = await self.db.scalar(
            select(func.count()).select_from(TradingAccount).where(
                TradingAccount.owner_id == user.id,
                TradingAccount.status == AccountStatus.ACTIVE,
            )
        )
        if (count or 0) >= s.max_paper_accounts_per_user:
            raise BusinessRuleViolation("Maximum number of paper accounts reached")

        account = TradingAccount(
            owner_id=user.id, name=data.name, mode=AccountMode.PAPER,
            base_currency=data.base_currency, status=AccountStatus.ACTIVE,
        )
        self.db.add(account)
        await self.db.flush()
        await self.ledger.create_chart(account)
        txn = await self.ledger.post(
            account, TransactionType.INITIAL_FUNDING,
            [Posting(LedgerCode.CASH, Direction.DEBIT, starting),
             Posting(LedgerCode.OPENING_EQUITY, Direction.CREDIT, starting)],
            description="Initial virtual funding", created_by=user.id,
        )
        await self.audit.record(
            ctx, "account.paper.create", resource_type="trading_account", resource_id=account.id,
            details={"name": account.name, "currency": account.base_currency,
                     "starting_balance": str(starting), "ledger_transaction_id": str(txn.id)},
        )
        return account

    async def _movement(
        self, user: User, account_id: uuid.UUID, data: CashMovement, ctx: AuditContext,
        *, kind: str, idempotency_key: str | None,
    ) -> tuple[LedgerTransaction, bool]:
        """Returns (transaction, created). Serialised per account via row lock."""
        account = await self.get_owned(user, account_id, for_update=True)
        if idempotency_key:
            existing = await self.ledger.find_by_idempotency_key(account.id, idempotency_key)
            if existing is not None:
                cash_leg = next(e for e in existing.entries if e.ledger_account.code == "CASH")
                if existing.type != kind or cash_leg.amount != data.amount:
                    raise Conflict("Idempotency key reused with a different request")
                return existing, False
        if account.status != AccountStatus.ACTIVE:
            raise BusinessRuleViolation("Account is not active")

        if kind == TransactionType.VIRTUAL_DEPOSIT:
            postings = [Posting(LedgerCode.CASH, Direction.DEBIT, data.amount),
                        Posting(LedgerCode.CAPITAL_CONTRIBUTIONS, Direction.CREDIT, data.amount)]
            balances = await self.ledger.balances([account.id])
            cash = LedgerService.summarise(balances[account.id])["cash"]
            if cash + data.amount > Decimal(self.settings.max_starting_balance):
                raise BusinessRuleViolation(
                    f"Virtual cash may not exceed {self.settings.max_starting_balance}"
                )
            action = "wallet.deposit"
        else:
            balances = await self.ledger.balances([account.id])
            cash = LedgerService.summarise(balances[account.id])["cash"]
            if data.amount > cash:
                raise BusinessRuleViolation("Insufficient virtual cash", details={
                    "available": str(cash), "requested": str(data.amount)})
            postings = [Posting(LedgerCode.CAPITAL_WITHDRAWALS, Direction.DEBIT, data.amount),
                        Posting(LedgerCode.CASH, Direction.CREDIT, data.amount)]
            action = "wallet.withdraw"

        txn = await self.ledger.post(
            account, kind, postings, description=data.description,
            idempotency_key=idempotency_key, created_by=user.id,
        )
        await self.audit.record(
            ctx, action, resource_type="trading_account", resource_id=account.id,
            details={"amount": str(data.amount), "currency": account.base_currency,
                     "ledger_transaction_id": str(txn.id)},
        )
        return txn, True

    async def deposit(self, user, account_id, data, ctx, idempotency_key=None):
        return await self._movement(user, account_id, data, ctx,
                                    kind=TransactionType.VIRTUAL_DEPOSIT,
                                    idempotency_key=idempotency_key)

    async def withdraw(self, user, account_id, data, ctx, idempotency_key=None):
        return await self._movement(user, account_id, data, ctx,
                                    kind=TransactionType.VIRTUAL_WITHDRAWAL,
                                    idempotency_key=idempotency_key)
