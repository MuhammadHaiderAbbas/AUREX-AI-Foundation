import json
import logging
import re
import time
import uuid

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.core.config import get_settings

log = logging.getLogger("aurex.http")
_SAFE_ID = re.compile(r"^[A-Za-z0-9_-]{8,64}$")

# The API only ever returns JSON/CSV: nothing may be rendered, framed or embedded.
API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
# Swagger UI loads its assets from a CDN; it is only served where docs are enabled.
DOCS_CSP = ("default-src 'self'; script-src 'self' https://cdn.jsdelivr.net 'unsafe-inline'; "
            "style-src 'self' https://cdn.jsdelivr.net 'unsafe-inline'; "
            "img-src 'self' data: https://fastapi.tiangolo.com; "
            "frame-ancestors 'none'")


class RequestContextMiddleware(BaseHTTPMiddleware):
    """Assigns a request id, adds security headers and logs request timing."""

    async def dispatch(self, request: Request, call_next):
        incoming = request.headers.get("x-request-id", "")
        request_id = incoming if _SAFE_ID.match(incoming) else uuid.uuid4().hex
        request.state.request_id = request_id
        start = time.perf_counter()
        response = await call_next(request)
        elapsed_ms = (time.perf_counter() - start) * 1000
        s = get_settings()
        h = response.headers
        h["X-Request-ID"] = request_id
        h["X-Content-Type-Options"] = "nosniff"
        h["X-Frame-Options"] = "DENY"
        h["Referrer-Policy"] = "no-referrer"
        h["Permissions-Policy"] = "camera=(), microphone=(), geolocation=(), payment=(), usb=()"
        h["Cross-Origin-Opener-Policy"] = "same-origin"
        h["Cross-Origin-Resource-Policy"] = "same-origin"
        docs = request.url.path.endswith(("/docs", "/redoc", "/docs/oauth2-redirect"))
        h["Content-Security-Policy"] = DOCS_CSP if docs else API_CSP
        if s.hsts_enabled:
            h["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
        h.setdefault("Cache-Control", "no-store")
        log.info(
            "%s %s -> %s (%.1f ms) rid=%s",
            request.method, request.url.path, response.status_code, elapsed_ms, request_id,
        )
        return response


async def _send_error(send: Send, status: int, code: str, message: str,
                      headers: list[tuple[bytes, bytes]] | None = None) -> None:
    body = json.dumps({"error": {"code": code, "message": message, "details": None, "request_id": None}}).encode()
    await send({"type": "http.response.start", "status": status,
                "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode()),
                            (b"cache-control", b"no-store"), *(headers or [])]})
    await send({"type": "http.response.body", "body": body})


class BodySizeLimitMiddleware:
    """Rejects request bodies over the limit with 413, whether or not Content-Length is sent
    (chunked bodies are counted as they stream in). Uploads get a larger, route-specific limit."""

    def __init__(self, app: ASGIApp, upload_suffixes: tuple[str, ...] = ("/research/documents/upload",)):
        self.app = app
        self.upload_suffixes = upload_suffixes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        s = get_settings()
        limit = s.max_upload_bytes if scope["path"].endswith(self.upload_suffixes) else s.max_request_bytes
        declared = dict(scope.get("headers") or []).get(b"content-length")
        if declared is not None and declared.isdigit() and int(declared) > limit:
            await _send_error(send, 413, "payload_too_large", f"Request body exceeds {limit} bytes")
            return
        received = 0
        state = {"started": False, "rejected": False}

        async def guarded_receive() -> Message:
            nonlocal received
            if state["rejected"]:
                return {"type": "http.disconnect"}
            msg = await receive()
            if msg["type"] == "http.request":
                received += len(msg.get("body", b""))
                if received > limit:
                    # Answer now and tell the app the client went away; whatever the app
                    # sends afterwards is dropped (frameworks turn read errors into 400s).
                    state["rejected"] = True
                    if not state["started"]:
                        state["started"] = True
                        await _send_error(send, 413, "payload_too_large", f"Request body exceeds {limit} bytes")
                    return {"type": "http.disconnect"}
            return msg

        async def guarded_send(msg: Message) -> None:
            if state["rejected"]:
                return
            if msg["type"] == "http.response.start":
                state["started"] = True
            await send(msg)

        await self.app(scope, guarded_receive, guarded_send)


_rate_windows: dict[str, tuple[int, int]] = {}


def reset_rate_limits() -> None:
    _rate_windows.clear()


class RateLimitMiddleware:
    """Per-client-IP fixed-window limit across the whole API (in-process, single node).
    Endpoint-specific limits (login, registration, agent runs, ...) still apply on top."""

    EXEMPT = ("/system/health", "/system/ready")

    def __init__(self, app: ASGIApp):
        self.app = app
        self.windows = _rate_windows

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        limit = get_settings().api_rate_limit_per_minute
        if scope["type"] != "http" or limit <= 0 or scope["path"].endswith(self.EXEMPT):
            await self.app(scope, receive, send)
            return
        ip = (scope.get("client") or ("unknown", 0))[0]
        minute = int(time.time() // 60)
        start, count = self.windows.get(ip, (minute, 0))
        if start != minute:
            start, count = minute, 0
            if len(self.windows) > 50_000:      # bound memory under address-spraying
                for k in [k for k, v in self.windows.items() if v[0] != minute]:
                    del self.windows[k]
        if count >= limit:
            retry = str(60 - int(time.time()) % 60)
            await _send_error(send, 429, "rate_limited", "Too many requests from this address",
                              [(b"retry-after", retry.encode())])
            return
        self.windows[ip] = (start, count + 1)
        await self.app(scope, receive, send)
