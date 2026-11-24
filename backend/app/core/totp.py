"""RFC 6238 time-based one-time passwords (SHA-1, 30 s, 6 digits: what authenticator apps expect)
and single-use recovery codes."""

import base64
import hashlib
import hmac
import secrets
import struct
import time
from urllib.parse import quote

STEP_SECONDS = 30
DIGITS = 6
WINDOW = 1          # accept one step of clock drift either way


def new_secret() -> str:
    return base64.b32encode(secrets.token_bytes(20)).decode().rstrip("=")


def _key(secret: str) -> bytes:
    s = secret.upper().replace(" ", "")
    return base64.b32decode(s + "=" * (-len(s) % 8))


def code_at(secret: str, step: int) -> str:
    digest = hmac.new(_key(secret), struct.pack(">Q", step), hashlib.sha1).digest()  # noqa: S324  # nosec B303 - RFC 6238 HOTP
    offset = digest[-1] & 0x0F
    value = struct.unpack(">I", digest[offset:offset + 4])[0] & 0x7FFFFFFF
    return str(value % 10**DIGITS).zfill(DIGITS)


def current_step(now: float | None = None) -> int:
    return int((time.time() if now is None else now) // STEP_SECONDS)


def verify(secret: str, code: str, *, last_step: int | None = None, now: float | None = None) -> int | None:
    """The matching time step, or None. Steps at or before `last_step` are refused (no replay)."""
    code = code.strip().replace(" ", "")
    if not (code.isdigit() and len(code) == DIGITS):
        return None
    step = current_step(now)
    for s in range(step - WINDOW, step + WINDOW + 1):
        if last_step is not None and s <= last_step:
            continue
        if hmac.compare_digest(code_at(secret, s), code):
            return s
    return None


def otpauth_uri(secret: str, account: str, issuer: str = "AUREX AI") -> str:
    label = quote(f"{issuer}:{account}")
    return f"otpauth://totp/{label}?secret={secret}&issuer={quote(issuer)}&algorithm=SHA1&digits={DIGITS}&period={STEP_SECONDS}"


# -- recovery codes ---------------------------------------------------------------------------------
def new_recovery_codes(n: int = 10) -> list[str]:
    return [f"{secrets.token_hex(4)}-{secrets.token_hex(4)}" for _ in range(n)]


def hash_recovery_code(code: str) -> str:
    # 64 bits of randomness per code: a fast hash is appropriate (nothing to brute-force from a dictionary).
    return hashlib.sha256(code.strip().lower().encode()).hexdigest()
