"""Live account stream: pushes trade, ledger, position, binary and risk changes, and a
mark-to-market valuation, for every paper account the user owns.

Protocol (JSON text frames, same auth handshake as the quote stream):
  client → {"type": "auth", "token": "<access token>"}       (first frame, within 10s)
  server → {"type": "ready", "accounts": [...], "interval_seconds": 1.0}
  server → {"type": "changed", "account_id": "...", "topics": ["orders", "executions", ...]}
  server → {"type": "valuation", "account_id": "...", "as_of": "...", "equity": "...", ...}

Changes are detected from database fingerprints (row counts and latest update times), so
the stream needs no pub/sub and sees fills made by the background worker on any replica.
"""

import asyncio
import uuid
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from fastapi.encoders import jsonable_encoder
from sqlalchemy import func, or_, select

from app.api.v1.markets import _authenticate_ws
from app.core.config import get_settings
from app.database.session import SessionLocal
from app.models import (
    BinaryContract,
    Execution,
    LedgerTransaction,
    Order,
    Position,
    RiskEvent,
    RiskProfile,
    TradingAccount,
)

router = APIRouter(tags=["stream"])
MAX_ACCOUNTS = 10


def _sub(model, *cols, where):
    return select(*cols).select_from(model).where(where).scalar_subquery()


async def fingerprints(db, account_ids: list[uuid.UUID]) -> dict[uuid.UUID, dict[str, Any]]:
    """One cheap row per account: counts and latest update times per topic."""
    out: dict[uuid.UUID, dict[str, Any]] = {}
    for aid in account_ids:
        row = (await db.execute(select(
            _sub(Order, func.count(), where=Order.account_id == aid),
            _sub(Order, func.max(Order.updated_at), where=Order.account_id == aid),
            _sub(Execution, func.count(), where=Execution.account_id == aid),
            _sub(LedgerTransaction, func.count(), where=LedgerTransaction.trading_account_id == aid),
            _sub(Position, func.max(Position.updated_at), where=Position.account_id == aid),
            _sub(Position, func.count(), where=Position.account_id == aid),
            _sub(BinaryContract, func.count(), where=BinaryContract.account_id == aid),
            _sub(BinaryContract, func.max(BinaryContract.updated_at), where=BinaryContract.account_id == aid),
            _sub(RiskEvent, func.count(), where=or_(RiskEvent.account_id == aid, RiskEvent.account_id.is_(None))),
            _sub(RiskProfile, func.max(RiskProfile.updated_at), where=RiskProfile.account_id == aid),
        ))).one()
        out[aid] = {"orders": (row[0], row[1]), "executions": row[2], "ledger": row[3], "positions": (row[4], row[5]),
                    "binary": (row[6], row[7]), "risk": (row[8], row[9])}
    return out


def changed_topics(before: dict[str, Any] | None, after: dict[str, Any]) -> list[str]:
    if before is None:
        return []
    return [k for k, v in after.items() if before.get(k) != v]


def valuation(summary: dict[str, Any]) -> dict[str, Any]:
    keys = ("equity", "cash", "available_cash", "market_value", "unrealised_pnl", "realised_pnl", "fees", "exposure",
            "binary_at_risk", "futures_margin", "futures_unrealised_pnl", "open_positions")
    return {
        **{k: summary.get(k) for k in keys},
        "as_of": datetime.now(UTC),
        "positions": [{k: p[k] for k in ("symbol", "last", "bid", "market_value", "unrealised_pnl", "unrealised_pct",
                                         "price_as_of", "stale")} for p in summary["positions"]],
    }


@router.websocket("/stream/account")
async def account_stream(ws: WebSocket):
    from app.trading.service import TradingService

    s = get_settings()
    interval = s.account_stream_interval_seconds
    await ws.accept()
    try:
        first = await asyncio.wait_for(ws.receive_json(), timeout=10)
    except (TimeoutError, WebSocketDisconnect, ValueError):
        await ws.close(code=4401)
        return
    user_id = await _authenticate_ws(str(first.get("token", ""))) if first.get("type") == "auth" else None
    if user_id is None:
        await ws.send_json({"type": "error", "message": "unauthorized"})
        await ws.close(code=4401)
        return

    async def owned() -> list[uuid.UUID]:
        async with SessionLocal() as db:
            return list(await db.scalars(select(TradingAccount.id).where(TradingAccount.owner_id == user_id)
                                         .order_by(TradingAccount.created_at).limit(MAX_ACCOUNTS)))

    accounts = await owned()
    await ws.send_json({"type": "ready", "accounts": [str(a) for a in accounts], "interval_seconds": interval})

    async def watch_disconnect():
        while True:
            await ws.receive_text()            # clients send nothing after auth; any frame is ignored

    reader = asyncio.create_task(watch_disconnect())
    last: dict[uuid.UUID, dict[str, Any]] = {}
    tick = 0
    try:
        while not reader.done():
            if tick:                                    # pick up accounts created after connecting
                fresh = await owned()
                for aid in set(fresh) - set(accounts):
                    await ws.send_json({"type": "changed", "account_id": str(aid), "topics": ["accounts"]})
                accounts = fresh
            async with SessionLocal() as db:
                fps = await fingerprints(db, accounts)
                for aid, fp in fps.items():
                    topics = changed_topics(last.get(aid), fp)
                    if topics:
                        await ws.send_json({"type": "changed", "account_id": str(aid), "topics": topics})
                last = fps
                if tick % max(1, round(s.account_valuation_interval_seconds / interval)) == 0:
                    ts = TradingService(db)
                    for aid in accounts:
                        acct = await db.get(TradingAccount, aid)
                        if acct is None:
                            continue
                        summary = await ts.summary(acct, take_snapshot=False)
                        await ws.send_json(jsonable_encoder({"type": "valuation", "account_id": aid, **valuation(summary)}))
                await db.rollback()             # read-only: never keep a transaction open between ticks
            tick += 1
            await asyncio.wait({reader}, timeout=interval)
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        reader.cancel()
