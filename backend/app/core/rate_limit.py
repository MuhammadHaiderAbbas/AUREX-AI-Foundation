"""Sliding-window rate limiter.

Shared across API replicas through Redis when AUREX_REDIS_URL is set (an atomic Lua script on a
sorted set, using Redis' own clock so replicas with skewed clocks agree), otherwise in process.

If Redis is unreachable the limiter fails *open* and counts the error
(`aurex_rate_limit_backend_errors_total`): a cache outage must not lock every user out of the
platform. The error is logged and alerted on (see infrastructure/monitoring/alerts.yml).
"""

import logging
import secrets
import time
from collections import defaultdict, deque
from threading import Lock

from redis.exceptions import RedisError

from app.core.redis import get_redis

log = logging.getLogger("aurex.ratelimit")
backend_errors = 0   # exported as a Prometheus counter

_SLIDING = """
local key, window, limit, member, record = KEYS[1], tonumber(ARGV[1]), tonumber(ARGV[2]), ARGV[3], ARGV[4]
local t = redis.call('TIME')
local now = tonumber(t[1]) + tonumber(t[2]) / 1000000
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)
local n = redis.call('ZCARD', key)
if record == '0' then return n end
if n >= limit then return -1 end
redis.call('ZADD', key, now, member)
redis.call('PEXPIRE', key, math.ceil(window * 1000))
return n + 1
"""


class SlidingWindowLimiter:
    def __init__(self, name: str) -> None:
        self.name = name
        self._hits: dict[str, deque[float]] = defaultdict(deque)
        self._lock = Lock()

    def _rkey(self, key: str) -> str:
        return f"aurex:rl:{self.name}:{key}"

    async def _redis(self, key: str, limit: int, window: int, record: bool) -> int | None:
        r = get_redis()
        if r is None:
            return None
        global backend_errors
        try:
            flag = "1" if record else "0"
            return int(await r.eval(_SLIDING, 1, self._rkey(key), window, limit, secrets.token_hex(8), flag))
        except (RedisError, OSError) as e:
            backend_errors += 1
            log.error("rate limit backend unavailable (%s): failing open", e.__class__.__name__)
            return 0 if not record else 1

    async def hit(self, key: str, limit: int, window_seconds: int) -> bool:
        """Record an attempt. Returns False if the limit is exceeded."""
        shared = await self._redis(key, limit, window_seconds, record=True)
        if shared is not None:
            return shared >= 0
        now = time.monotonic()
        with self._lock:
            q = self._hits[key]
            while q and now - q[0] > window_seconds:
                q.popleft()
            if len(q) >= limit:
                return False
            q.append(now)
            return True

    async def count(self, key: str, window_seconds: int) -> int:
        """Attempts within the window, without recording a new one."""
        shared = await self._redis(key, 0, window_seconds, record=False)
        if shared is not None:
            return shared
        now = time.monotonic()
        with self._lock:
            q = self._hits.get(key)
            if not q:
                return 0
            while q and now - q[0] > window_seconds:
                q.popleft()
            return len(q)

    async def clear(self, key: str) -> None:
        r = get_redis()
        if r is not None:
            try:
                await r.delete(self._rkey(key))
            except (RedisError, OSError):
                pass
        with self._lock:
            self._hits.pop(key, None)

    def reset(self, key: str | None = None) -> None:
        """Clear the in-process state (tests)."""
        with self._lock:
            if key is None:
                self._hits.clear()
            else:
                self._hits.pop(key, None)


login_limiter = SlidingWindowLimiter("login")
