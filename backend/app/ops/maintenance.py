"""Maintenance mode ("site on hold"), switched by administrators.

While enabled, traders cannot sign in, refresh a session or call the API (HTTP 503, code
"maintenance"); administrators keep full access. The background worker pauses AI bots and the
autopilot; the order matcher keeps running so protective stops and limit orders still work.
"""

import time
from datetime import UTC, datetime
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import ServiceUnavailable
from app.ops import controls

KEY = "maintenance"
OFF: dict[str, Any] = {"enabled": False, "message": None, "until": None, "since": None}
_cache: tuple[float, dict[str, Any]] | None = None


async def state(db: AsyncSession, fresh: bool = False) -> dict[str, Any]:
    """Current state; cached for 2 seconds because every API request checks it."""
    global _cache
    if not fresh and _cache and time.monotonic() - _cache[0] < 2:
        return _cache[1]
    value = {**OFF, **(await controls.get(db, KEY) or {})}
    _cache = (time.monotonic(), value)
    return value


async def set_state(db: AsyncSession, enabled: bool, message: str | None, until: datetime | None, actor) -> dict[str, Any]:
    global _cache
    value = {"enabled": enabled, "message": message if enabled else None, "until": until.isoformat() if enabled and until else None,
             "since": datetime.now(UTC).isoformat() if enabled else None}
    await controls.put(db, KEY, value, actor=actor)
    _cache = None
    return value


def clear_cache() -> None:
    global _cache
    _cache = None


async def ensure_open(db: AsyncSession, user) -> None:
    if user is not None and getattr(user, "is_admin", False):
        return
    s = await state(db)
    if s["enabled"]:
        raise ServiceUnavailable(s["message"] or "AUREX is temporarily on hold for maintenance.", code="maintenance",
                                 details={"until": s["until"]})
