"""Database-level guarantees that hold even if application code is wrong."""

import uuid
from decimal import Decimal

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import DBAPIError, IntegrityError

from app.database.session import SessionLocal
from app.models import LedgerAccount, LedgerEntry, LedgerTransaction, TradingAccount
from app.services.ledger_service import LedgerImbalance, LedgerService, Posting
from tests.conftest import API, auth_headers


async def _account_id(client) -> uuid.UUID:
    h = await auth_headers(client)
    r = await client.post(f"{API}/accounts", headers=h, json={"name": "x"})
    return uuid.UUID(r.json()["id"])


async def test_unbalanced_transaction_rejected_by_database(client):
    aid = await _account_id(client)
    async with SessionLocal() as db:
        cash = await db.scalar(select(LedgerAccount).where(
            LedgerAccount.trading_account_id == aid, LedgerAccount.code == "CASH"))
        txn = LedgerTransaction(trading_account_id=aid, type="TEST", description="bad")
        db.add(txn)
        await db.flush()
        db.add(LedgerEntry(transaction_id=txn.id, ledger_account_id=cash.id, direction="DEBIT",
                           amount=Decimal("1"), currency="USD"))
        await db.flush()
        with pytest.raises(DBAPIError, match="unbalanced"):
            await db.commit()


async def test_service_rejects_unbalanced_postings(client):
    aid = await _account_id(client)
    async with SessionLocal() as db:
        acct = await db.get(TradingAccount, aid)
        with pytest.raises(LedgerImbalance):
            await LedgerService(db).post(acct, "TEST", [
                Posting("CASH", "DEBIT", Decimal("10")),
                Posting("OPENING_EQUITY", "CREDIT", Decimal("9")),
            ])


@pytest.mark.parametrize("table", ["ledger_entries", "ledger_transactions"])
async def test_ledger_is_append_only(client, table):
    await _account_id(client)
    async with SessionLocal() as db:
        with pytest.raises(DBAPIError, match="append-only"):
            await db.execute(text(f"DELETE FROM {table}"))  # noqa: S608
    async with SessionLocal() as db:
        col = "amount = amount * 2" if table == "ledger_entries" else "description = 'x'"
        with pytest.raises(DBAPIError, match="append-only"):
            await db.execute(text(f"UPDATE {table} SET {col}"))  # noqa: S608


async def test_live_accounts_blocked_by_database(client):
    aid = await _account_id(client)
    async with SessionLocal() as db:
        owner = (await db.get(TradingAccount, aid)).owner_id
        db.add(TradingAccount(owner_id=owner, name="live", mode="LIVE", base_currency="USD"))
        with pytest.raises(IntegrityError, match="paper_only"):
            await db.commit()
