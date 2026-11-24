"""Optional shared Redis connection (AUREX_REDIS_URL). Without it the API runs single-node:
rate limits are kept in process."""

import redis.asyncio as aioredis

from app.core.config import get_settings

_clients: dict[str, aioredis.Redis] = {}


def get_redis() -> aioredis.Redis | None:
    url = get_settings().redis_url
    if not url:
        return None
    if url not in _clients:
        _clients[url] = aioredis.from_url(url, socket_timeout=0.5, socket_connect_timeout=0.5, health_check_interval=30)
    return _clients[url]


async def close_redis() -> None:
    for c in _clients.values():
        await c.aclose()
    _clients.clear()
