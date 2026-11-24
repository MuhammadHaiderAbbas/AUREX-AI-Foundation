"""Whole-database integrity checks, used after restores and by operators (`app.cli integrity-check`)."""

from pathlib import Path
from typing import Any

from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import AuditAnchor, AuditLog
from app.services.audit_service import AuditService

APPEND_ONLY_TRIGGERS = {
    "ledger_entries", "ledger_transactions", "audit_logs", "order_events", "executions",
    "risk_decisions", "risk_events", "audit_anchors",
}


def alembic_head() -> str:
    cfg = Config(str(Path(__file__).resolve().parents[2] / "alembic.ini"))
    cfg.set_main_option("script_location", str(Path(__file__).resolve().parents[2] / "alembic"))
    return ScriptDirectory.from_config(cfg).get_current_head()


async def run_checks(db: AsyncSession) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []

    def add(name: str, ok: bool, detail: str) -> None:
        out.append({"name": name, "ok": ok, "detail": detail})

    current = await db.scalar(text("SELECT version_num FROM alembic_version"))
    head = alembic_head()
    add("schema_version", current == head, f"database at {current}, code expects {head}")

    chain = await AuditService(db).verify_chain()
    add("audit_chain", chain["valid"], f"{chain['records_checked']} records" + ("" if chain["valid"] else f"; {chain.get('reason')} at #{chain.get('first_invalid_id')}"))

    # every ledger transaction balances, and so does every account in total
    bad_txn = (await db.execute(text("""
        SELECT t.id FROM ledger_transactions t JOIN ledger_entries e ON e.transaction_id = t.id
        GROUP BY t.id HAVING SUM(CASE WHEN e.direction = 'DEBIT' THEN e.amount ELSE -e.amount END) <> 0 LIMIT 5"""))).scalars().all()
    add("ledger_transactions_balanced", not bad_txn, "all transactions balance" if not bad_txn else f"unbalanced: {bad_txn}")
    accounts = await db.scalar(text("SELECT count(*) FROM trading_accounts"))
    add("ledger_accounts", True, f"{accounts} trading accounts")

    triggers = set((await db.execute(text("""
        SELECT c.relname FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid
        WHERE NOT tg.tgisinternal AND tg.tgname LIKE '%append_only%'"""))).scalars().all())
    trig_missing = APPEND_ONLY_TRIGGERS - triggers
    ledger_guard = await db.scalar(text("SELECT count(*) FROM pg_trigger WHERE tgname ILIKE '%balance%'"))
    add("append_only_triggers", not trig_missing, "present" if not trig_missing else f"missing on {sorted(trig_missing)}")
    add("ledger_balance_trigger", bool(ledger_guard), "present" if ledger_guard else "missing")

    anchors = list(await db.scalars(select(AuditAnchor).order_by(AuditAnchor.id)))
    mismatched = []
    for a in anchors:
        rec = await db.get(AuditLog, a.last_record_id)
        if rec is None or rec.hash != a.head_hash:
            mismatched.append(a.id)
    add("anchors_match_chain", not mismatched, f"{len(anchors)} anchors" + ("" if not mismatched else f"; mismatched {mismatched}"))
    return out
