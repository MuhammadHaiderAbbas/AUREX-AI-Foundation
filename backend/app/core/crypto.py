"""Authenticated encryption (AES-256-GCM) for small secrets at rest, e.g. TOTP seeds.

Keys: AUREX_DATA_KEY if set, otherwise derived from the JWT secret. Decryption also tries keys
derived from AUREX_JWT_PREVIOUS_SECRETS, so rotating the JWT secret does not lock anyone out;
values are re-encrypted with the current key the next time they are written.
"""

import base64
import hashlib
import hmac
import secrets

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from app.core.config import get_settings

PREFIX = "v1:"


def _derive(material: str) -> bytes:
    return hmac.new(material.encode(), b"aurex-data-key-v1", hashlib.sha256).digest()


def _keys() -> list[bytes]:
    s = get_settings()
    keys = [hashlib.sha256(s.data_key.encode()).digest()] if s.data_key else []
    keys += [_derive(k) for k in [s.jwt_secret, *s.jwt_previous_secrets]]
    return keys


def encrypt(plaintext: str, context: str) -> str:
    nonce = secrets.token_bytes(12)
    ct = AESGCM(_keys()[0]).encrypt(nonce, plaintext.encode(), context.encode())
    return PREFIX + base64.b64encode(nonce + ct).decode()


def decrypt(token: str, context: str) -> str:
    if not token.startswith(PREFIX):
        raise ValueError("unknown ciphertext format")
    raw = base64.b64decode(token[len(PREFIX):])
    for key in _keys():
        try:
            return AESGCM(key).decrypt(raw[:12], raw[12:], context.encode()).decode()
        except InvalidTag:
            continue
    raise ValueError("cannot decrypt: no matching key")
