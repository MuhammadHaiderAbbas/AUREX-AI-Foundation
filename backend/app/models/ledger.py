"""Double-entry ledger.

Balances are never stored; they are derived from immutable ledger entries.
Postgres triggers (see the foundation migration) enforce that:
  * every ledger transaction's debits equal its credits (deferred, at commit), and
  * ledger rows can never be updated or deleted.
"""

import uuid
from datetime import datetime
from decimal import Decimal

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    Uuid,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database.base import Base, UUIDPk, utcnow

MONEY = Numeric(28, 8)


class LedgerAccountType:
    ASSET = "ASSET"
    LIABILITY = "LIABILITY"
    EQUITY = "EQUITY"
    INCOME = "INCOME"
    EXPENSE = "EXPENSE"
    DEBIT_NORMAL = (ASSET, EXPENSE)


class LedgerCode:
    CASH = "CASH"
    INVESTMENTS = "INVESTMENTS"
    OPENING_EQUITY = "OPENING_EQUITY"
    CAPITAL_CONTRIBUTIONS = "CAPITAL_CONTRIBUTIONS"
    CAPITAL_WITHDRAWALS = "CAPITAL_WITHDRAWALS"
    REALISED_PNL = "REALISED_PNL"
    FEES = "FEES"


# Chart of accounts created for every trading account.
CHART_OF_ACCOUNTS: list[tuple[str, str, str]] = [
    (LedgerCode.CASH, LedgerAccountType.ASSET, "Cash"),
    (LedgerCode.INVESTMENTS, LedgerAccountType.ASSET, "Investments at cost"),
    (LedgerCode.OPENING_EQUITY, LedgerAccountType.EQUITY, "Opening equity"),
    (LedgerCode.CAPITAL_CONTRIBUTIONS, LedgerAccountType.EQUITY, "Capital contributions"),
    (LedgerCode.CAPITAL_WITHDRAWALS, LedgerAccountType.EQUITY, "Capital withdrawals"),
    (LedgerCode.REALISED_PNL, LedgerAccountType.INCOME, "Realised profit and loss"),
    (LedgerCode.FEES, LedgerAccountType.EXPENSE, "Trading fees"),
]


class Direction:
    DEBIT = "DEBIT"
    CREDIT = "CREDIT"


class TransactionType:
    INITIAL_FUNDING = "INITIAL_FUNDING"
    VIRTUAL_DEPOSIT = "VIRTUAL_DEPOSIT"
    VIRTUAL_WITHDRAWAL = "VIRTUAL_WITHDRAWAL"


class LedgerAccount(UUIDPk, Base):
    __tablename__ = "ledger_accounts"
    __table_args__ = (
        UniqueConstraint("trading_account_id", "code", "currency", name="uq_ledger_account_code"),
        CheckConstraint(
            "type IN ('ASSET','LIABILITY','EQUITY','INCOME','EXPENSE')", name="type_valid"
        ),
    )

    trading_account_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("trading_accounts.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    code: Mapped[str] = mapped_column(String(40), nullable=False)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    type: Mapped[str] = mapped_column(String(10), nullable=False)
    currency: Mapped[str] = mapped_column(String(3), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), default=utcnow
    )


class LedgerTransaction(UUIDPk, Base):
    __tablename__ = "ledger_transactions"
    __table_args__ = (
        UniqueConstraint("trading_account_id", "idempotency_key", name="uq_ledger_txn_idem"),
    )

    trading_account_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("trading_accounts.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    type: Mapped[str] = mapped_column(String(32), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False, default="")
    idempotency_key: Mapped[str | None] = mapped_column(String(128))
    created_by: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), default=utcnow
    )

    entries: Mapped[list["LedgerEntry"]] = relationship(
        back_populates="transaction", lazy="selectin", order_by="LedgerEntry.direction.desc()"
    )


class LedgerEntry(UUIDPk, Base):
    __tablename__ = "ledger_entries"
    __table_args__ = (
        CheckConstraint("amount > 0", name="amount_positive"),
        CheckConstraint("direction IN ('DEBIT','CREDIT')", name="direction_valid"),
    )

    transaction_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("ledger_transactions.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    ledger_account_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("ledger_accounts.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    direction: Mapped[str] = mapped_column(String(6), nullable=False)
    amount: Mapped[Decimal] = mapped_column(MONEY, nullable=False)
    currency: Mapped[str] = mapped_column(String(3), nullable=False)

    transaction: Mapped[LedgerTransaction] = relationship(back_populates="entries")
    ledger_account: Mapped[LedgerAccount] = relationship(lazy="joined")
