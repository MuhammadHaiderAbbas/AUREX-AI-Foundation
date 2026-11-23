import uuid
from dataclasses import dataclass
from decimal import Decimal

from sqlalchemy import case, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError
from app.models import LedgerAccount, LedgerEntry, LedgerTransaction, TradingAccount
from app.models.ledger import CHART_OF_ACCOUNTS, Direction, LedgerAccountType, LedgerCode


@dataclass(frozen=True)
class Posting:
    code: str
    direction: str
    amount: Decimal


class LedgerImbalance(AppError):
    code = "ledger_imbalance"


class LedgerService:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def create_chart(self, account: TradingAccount) -> None:
        for code, type_, name in CHART_OF_ACCOUNTS:
            self.db.add(LedgerAccount(
                trading_account_id=account.id, code=code, name=name, type=type_,
                currency=account.base_currency,
            ))
        await self.db.flush()

    async def _ledger_accounts(self, account: TradingAccount) -> dict[str, LedgerAccount]:
        rows = await self.db.scalars(
            select(LedgerAccount).where(
                LedgerAccount.trading_account_id == account.id,
                LedgerAccount.currency == account.base_currency,
            )
        )
        return {la.code: la for la in rows}

    async def find_by_idempotency_key(
        self, account_id: uuid.UUID, key: str
    ) -> LedgerTransaction | None:
        return await self.db.scalar(
            select(LedgerTransaction).where(
                LedgerTransaction.trading_account_id == account_id,
                LedgerTransaction.idempotency_key == key,
            )
        )

    async def post(
        self,
        account: TradingAccount,
        type_: str,
        postings: list[Posting],
        *,
        description: str = "",
        idempotency_key: str | None = None,
        created_by: uuid.UUID | None = None,
    ) -> LedgerTransaction:
        debits = sum((p.amount for p in postings if p.direction == Direction.DEBIT), Decimal(0))
        credits = sum((p.amount for p in postings if p.direction == Direction.CREDIT), Decimal(0))
        if len(postings) < 2 or debits != credits or any(p.amount <= 0 for p in postings):
            # Also enforced by a deferred trigger in Postgres; this gives a clean error.
            raise LedgerImbalance("Ledger transaction must balance (debits == credits)")

        accounts = await self._ledger_accounts(account)
        txn = LedgerTransaction(
            trading_account_id=account.id, type=type_, description=description,
            idempotency_key=idempotency_key, created_by=created_by,
        )
        self.db.add(txn)
        await self.db.flush()
        for p in postings:
            la = accounts.get(p.code)
            if la is None:
                raise LedgerImbalance(f"Unknown ledger account {p.code}")
            self.db.add(LedgerEntry(
                transaction_id=txn.id, ledger_account_id=la.id, direction=p.direction,
                amount=p.amount, currency=account.base_currency,
            ))
        await self.db.flush()
        await self.db.refresh(txn, ["entries"])
        return txn

    async def balances(self, account_ids: list[uuid.UUID]) -> dict[uuid.UUID, list[dict]]:
        """Natural-sign balance of every ledger account, derived from entries."""
        signed = case(
            (LedgerEntry.direction == Direction.DEBIT, LedgerEntry.amount),
            else_=-LedgerEntry.amount,
        )
        q = (
            select(
                LedgerAccount.trading_account_id, LedgerAccount.code, LedgerAccount.name,
                LedgerAccount.type, LedgerAccount.currency,
                func.coalesce(func.sum(signed), 0).label("net_debit"),
            )
            .outerjoin(LedgerEntry, LedgerEntry.ledger_account_id == LedgerAccount.id)
            .where(LedgerAccount.trading_account_id.in_(account_ids))
            .group_by(LedgerAccount.id)
            .order_by(LedgerAccount.code)
        )
        out: dict[uuid.UUID, list[dict]] = {aid: [] for aid in account_ids}
        for row in (await self.db.execute(q)).all():
            net = Decimal(row.net_debit)
            balance = net if row.type in LedgerAccountType.DEBIT_NORMAL else -net
            out[row.trading_account_id].append({
                "code": row.code, "name": row.name, "type": row.type,
                "currency": row.currency, "balance": balance, "_net_debit": net,
            })
        return out

    @staticmethod
    def summarise(lines: list[dict]) -> dict:
        by_code = {ln["code"]: ln["balance"] for ln in lines}
        assets = sum((ln["balance"] for ln in lines if ln["type"] == LedgerAccountType.ASSET),
                     Decimal(0))
        liabilities = sum(
            (ln["balance"] for ln in lines if ln["type"] == LedgerAccountType.LIABILITY),
            Decimal(0),
        )
        return {
            "cash": by_code.get(LedgerCode.CASH, Decimal(0)),
            "investments": by_code.get(LedgerCode.INVESTMENTS, Decimal(0)),
            "equity": assets - liabilities,
            "ledger_balanced": sum((ln["_net_debit"] for ln in lines), Decimal(0)) == 0,
        }

    async def transactions(
        self, account_id: uuid.UUID, *, limit: int, offset: int
    ) -> tuple[list[LedgerTransaction], int]:
        base = select(LedgerTransaction).where(LedgerTransaction.trading_account_id == account_id)
        total = await self.db.scalar(select(func.count()).select_from(base.subquery()))
        rows = await self.db.scalars(
            base.order_by(LedgerTransaction.created_at.desc(), LedgerTransaction.id)
            .limit(limit).offset(offset)
        )
        return list(rows), int(total or 0)
