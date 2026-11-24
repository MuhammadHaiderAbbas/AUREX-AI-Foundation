"""The background worker: order matcher, breaker monitor, autopilot cycles and audit anchoring.

Every API replica runs this loop, but only the replica holding a Postgres *session* advisory lock
does the work (leader election with no extra infrastructure). If the leader dies its connection
closes, the lock is released, and another replica takes over on its next pass. The matcher was
already safe to run concurrently (FOR UPDATE SKIP LOCKED); leadership additionally keeps
autopilot cycles and anchors from running twice.
"""

import asyncio
import logging
import os
import socket
from datetime import UTC, datetime

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection

from app.core.config import get_settings
from app.database.session import SessionLocal, engine
from app.ops import anchoring, controls

log = logging.getLogger("aurex.worker")
LEADER_LOCK = 0x41555258  # "AURX"
INSTANCE = f"{socket.gethostname()}:{os.getpid()}"


class Lease:
    def __init__(self) -> None:
        self.conn: AsyncConnection | None = None

    @property
    def held(self) -> bool:
        return self.conn is not None and not self.conn.closed

    async def acquire(self) -> bool:
        if self.held:
            try:
                await self.conn.execute(text("SELECT 1"))     # still alive? (lock lives with the session)
                return True
            except Exception:  # noqa: BLE001
                await self.release()
        conn = await engine.connect()
        got = await conn.scalar(text("SELECT pg_try_advisory_lock(:k)"), {"k": LEADER_LOCK})
        await conn.commit()
        if got:
            self.conn = conn
            log.info("background worker: %s is now the leader", INSTANCE)
            return True
        await conn.close()
        return False

    async def release(self) -> None:
        if self.conn is not None:
            try:
                await self.conn.execute(text("SELECT pg_advisory_unlock(:k)"), {"k": LEADER_LOCK})
                await self.conn.close()
            except Exception:  # noqa: BLE001 - the connection may already be gone (lock released with it)
                log.debug("leader lease connection already closed")
            self.conn = None


lease = Lease()
state = {"passes": 0, "last_error": None, "leader": False}


async def one_pass() -> dict:
    """A single leader pass. Separated from the loop so it can be tested directly."""
    from app.risk.autopilot import due_accounts, run_cycle
    from app.risk.service import RiskService
    from app.trading.service import TradingService

    s = get_settings()
    async with SessionLocal() as db:
        stats = await TradingService(db).process_open()
        await TradingService(db).monitor()
        await db.commit()
    async with SessionLocal() as db:
        for acct in await due_accounts(db, s.autopilot_interval_seconds):
            prof = await RiskService(db).profile(acct.id, lock=True)
            await run_cycle(db, acct, prof)
            await db.commit()
    anchored = False
    if anchoring.sinks_configured():
        async with SessionLocal() as db:
            last = await anchoring.last_anchor(db)
            if last is None or (datetime.now(UTC) - last.created_at).total_seconds() >= s.audit_anchor_interval_seconds:
                await anchoring.anchor_now(db)
                await db.commit()
                anchored = True
    return {"matcher": stats, "anchored": anchored}


async def heartbeat(error: str | None = None) -> None:
    async with SessionLocal() as db:
        await controls.put(db, controls.HEARTBEAT, {"at": datetime.now(UTC).isoformat(), "instance": INSTANCE,
                                                   "passes": state["passes"], "last_error": error})
        await db.commit()


async def run(interval: float) -> None:
    while True:
        await asyncio.sleep(interval)
        try:
            state["leader"] = await lease.acquire()
            if not state["leader"]:
                continue
            out = await one_pass()
            state["passes"] += 1
            state["last_error"] = None
            await heartbeat()
            if out["matcher"]["filled"] or out["matcher"]["expired"] or out["anchored"]:
                log.info("worker pass: %s", out)
        except asyncio.CancelledError:
            await lease.release()
            raise
        except Exception as e:  # noqa: BLE001 - the loop must survive transient failures
            state["last_error"] = e.__class__.__name__
            log.exception("background worker pass failed")
            try:
                await heartbeat(state["last_error"])
            except Exception:  # noqa: BLE001 - database unavailable; readiness will show the stale heartbeat
                log.warning("could not record worker heartbeat")
