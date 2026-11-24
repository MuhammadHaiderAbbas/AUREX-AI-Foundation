import hashlib
import hmac
import secrets
import uuid
from datetime import UTC, datetime, timedelta

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError

from app.core.config import get_settings

_hasher = PasswordHasher()
# Used to equalise timing when the user does not exist.
_DUMMY_HASH = _hasher.hash("aurex-timing-equaliser")


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password: str, password_hash: str | None) -> bool:
    try:
        return _hasher.verify(password_hash or _DUMMY_HASH, password) and password_hash is not None
    except (VerificationError, InvalidHashError):
        return False


def password_needs_rehash(password_hash: str) -> bool:
    return _hasher.check_needs_rehash(password_hash)


def create_access_token(user_id: uuid.UUID, role: str, session_id: uuid.UUID) -> tuple[str, int]:
    s = get_settings()
    now = datetime.now(UTC)
    ttl = s.access_token_ttl_minutes * 60
    payload = {
        "sub": str(user_id),
        "role": role,
        "sid": str(session_id),
        "type": "access",
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(seconds=ttl)).timestamp()),
        "jti": secrets.token_hex(8),
    }
    return jwt.encode(payload, s.jwt_secret, algorithm=s.jwt_algorithm,
                      headers={"kid": key_id(s.jwt_secret)}), ttl


def key_id(secret: str) -> str:
    """Public, non-reversible identifier of a signing secret (for rotation)."""
    return hashlib.sha256(b"aurex-kid:" + secret.encode()).hexdigest()[:16]


def decode_access_token(token: str) -> dict:
    """Verify with the current secret or, during a rotation, a previous one (chosen by kid)."""
    s = get_settings()
    keys = {key_id(k): k for k in [s.jwt_secret, *s.jwt_previous_secrets]}
    kid = jwt.get_unverified_header(token).get("kid")
    if kid is None:
        secret = s.jwt_secret          # tokens issued before key ids were introduced
    elif kid in keys:
        secret = keys[kid]
    else:
        raise jwt.InvalidTokenError("unknown signing key")
    payload = jwt.decode(
        token, secret, algorithms=[s.jwt_algorithm], options={"require": ["exp", "sub", "iat"]}
    )
    if payload.get("type") != "access":
        raise jwt.InvalidTokenError("not an access token")
    return payload


def new_refresh_token() -> str:
    return secrets.token_urlsafe(48)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _artifact_key() -> bytes:
    s = get_settings()
    if s.artifact_key:
        return s.artifact_key.encode()
    return hmac.new(s.jwt_secret.encode(), b"aurex-artifact-key-v1", hashlib.sha256).digest()


def sign_artifact(data: bytes) -> str:
    """HMAC-SHA256 of a model artifact. Unlike a plain hash stored next to the artifact,
    it cannot be recomputed by someone who can only write to the database."""
    return hmac.new(_artifact_key(), data, hashlib.sha256).hexdigest()


def verify_artifact(data: bytes, mac: str | None) -> bool:
    return mac is not None and hmac.compare_digest(sign_artifact(data), mac)


MFA_CHALLENGE_TTL = 300


def create_mfa_challenge(user_id: uuid.UUID) -> str:
    """Short-lived proof that the password step passed; exchanged for tokens with a TOTP code."""
    s = get_settings()
    now = datetime.now(UTC)
    payload = {"sub": str(user_id), "type": "mfa_challenge", "iat": int(now.timestamp()),
               "exp": int((now + timedelta(seconds=MFA_CHALLENGE_TTL)).timestamp()), "jti": secrets.token_hex(8)}
    return jwt.encode(payload, s.jwt_secret, algorithm=s.jwt_algorithm, headers={"kid": key_id(s.jwt_secret)})


def decode_mfa_challenge(token: str) -> uuid.UUID:
    s = get_settings()
    keys = {key_id(k): k for k in [s.jwt_secret, *s.jwt_previous_secrets]}
    kid = jwt.get_unverified_header(token).get("kid")
    if kid not in keys:
        raise jwt.InvalidTokenError("unknown signing key")
    payload = jwt.decode(token, keys[kid], algorithms=[s.jwt_algorithm], options={"require": ["exp", "sub", "iat"]})
    if payload.get("type") != "mfa_challenge":
        raise jwt.InvalidTokenError("not an MFA challenge")
    return uuid.UUID(payload["sub"])
