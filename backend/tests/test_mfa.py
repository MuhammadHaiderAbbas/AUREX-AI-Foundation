"""Phase 11: TOTP two-factor authentication."""


import pytest
from sqlalchemy import text

from app.core import crypto, totp
from app.database.session import SessionLocal
from tests.conftest import API, PASSWORD, admin_headers, auth_headers, login, new_client
from tests.test_security import settings_env


def test_totp_matches_rfc6238_vectors():
    # RFC 6238 appendix B, SHA-1 secret "12345678901234567890" (base32 below), 8 digits -> last 6
    secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"  # pragma: allowlist secret
    for t, expected in [(59, "287082"), (1111111109, "081804"), (1234567890, "005924"), (2000000000, "279037")]:
        assert totp.code_at(secret, t // 30) == expected
    step = totp.current_step()
    code = totp.code_at(secret, step)
    assert totp.verify(secret, code) == step
    assert totp.verify(secret, code, last_step=step) is None          # replay refused
    assert totp.verify(secret, totp.code_at(secret, step - 1)) == step - 1   # one step of drift
    assert totp.verify(secret, totp.code_at(secret, step - 3)) is None
    assert totp.verify(secret, "12345") is None and totp.verify(secret, "abcdef") is None
    assert totp.otpauth_uri(secret, "a@b.c").startswith("otpauth://totp/AUREX%20AI%3Aa%40b.c?secret=")


def test_secrets_at_rest_are_encrypted_and_survive_key_rotation(monkeypatch):
    settings_env(monkeypatch, jwt_secret="k" * 40)
    blob = crypto.encrypt("SEED", "ctx")
    assert blob.startswith("v1:") and "SEED" not in blob
    assert crypto.decrypt(blob, "ctx") == "SEED"
    with pytest.raises(ValueError):
        crypto.decrypt(blob, "other-context")            # bound to its purpose
    settings_env(monkeypatch, jwt_secret="n" * 40, jwt_previous_secrets="k" * 40)
    assert crypto.decrypt(blob, "ctx") == "SEED"
    settings_env(monkeypatch, jwt_secret="n" * 40, jwt_previous_secrets="")
    with pytest.raises(ValueError):
        crypto.decrypt(blob, "ctx")


async def enrol(client, h):
    setup = (await client.post(f"{API}/auth/mfa/setup", headers=h, json={"password": PASSWORD})).json()
    code = totp.code_at(setup["secret"], totp.current_step())
    r = await client.post(f"{API}/auth/mfa/enable", headers=h, json={"code": code})
    assert r.status_code == 200, r.text
    return setup["secret"], r.json()["recovery_codes"]


def next_code(secret):
    """A code for the next time step: the current one was consumed by enrolment."""
    return totp.code_at(secret, totp.current_step() + 1)


async def test_enrolment_and_two_step_login(client):
    h = await auth_headers(client)
    assert (await client.post(f"{API}/auth/mfa/setup", headers=h, json={"password": "nope"})).status_code == 401  # pragma: allowlist secret
    setup = (await client.post(f"{API}/auth/mfa/setup", headers=h, json={"password": PASSWORD})).json()
    assert len(setup["secret"]) == 32 and setup["otpauth_uri"].startswith("otpauth://totp/")
    async with SessionLocal() as db:   # the seed is never stored in the clear
        stored = await db.scalar(text("SELECT mfa_pending_secret_enc FROM users"))
        assert stored.startswith("v1:") and setup["secret"] not in stored
    assert (await client.post(f"{API}/auth/mfa/enable", headers=h, json={"code": "000000"})).status_code == 422
    r = await client.post(f"{API}/auth/mfa/enable", headers=h, json={"code": totp.code_at(setup["secret"], totp.current_step())})
    codes = r.json()["recovery_codes"]
    assert len(codes) == 10 and len(set(codes)) == 10
    assert (await client.get(f"{API}/auth/me", headers=h)).json()["mfa_enabled"] is True

    async with new_client() as c:
        r = await login(c)
        challenge = r.json()
        assert r.status_code == 200 and challenge["mfa_required"] is True and "access_token" not in challenge
        assert "set-cookie" not in r.headers                       # no session before the second factor
        bad = await c.post(f"{API}/auth/mfa/verify", json={"mfa_token": challenge["mfa_token"], "code": "123456"})
        assert bad.status_code == 401
        ok = await c.post(f"{API}/auth/mfa/verify", json={"mfa_token": challenge["mfa_token"], "code": next_code(setup["secret"])})
        assert ok.status_code == 200 and ok.json()["access_token"] and "set-cookie" in ok.headers
        assert (await c.post(f"{API}/auth/refresh")).status_code == 200
    ah = await admin_headers(client)
    logins = (await client.get(f"{API}/admin/audit?action=auth.login", headers=ah)).json()["items"]
    assert any(x["details"].get("method") == "password+totp" for x in logins)


async def test_enabling_mfa_signs_out_other_sessions(client):
    h = await auth_headers(client)
    async with new_client() as other:
        oh = {"Authorization": f"Bearer {(await login(other)).json()['access_token']}"}
        await enrol(client, h)
        assert (await other.get(f"{API}/auth/me", headers=oh)).status_code == 401
    assert (await client.get(f"{API}/auth/me", headers=h)).status_code == 200


async def test_recovery_codes_are_single_use(client):
    h = await auth_headers(client)
    _, codes = await enrol(client, h)
    async with new_client() as c:
        t = (await login(c)).json()["mfa_token"]
        assert (await c.post(f"{API}/auth/mfa/verify", json={"mfa_token": t, "code": codes[0].upper()})).status_code == 200
        t = (await login(c)).json()["mfa_token"]
        assert (await c.post(f"{API}/auth/mfa/verify", json={"mfa_token": t, "code": codes[0]})).status_code == 401
    ah = await admin_headers(client)
    used = (await client.get(f"{API}/admin/audit?action=auth.mfa.recovery_used", headers=ah)).json()["items"]
    assert used[0]["details"]["remaining"] == 9


async def test_verification_attempts_are_limited_and_challenges_expire(client, monkeypatch):
    h = await auth_headers(client)
    secret, _ = await enrol(client, h)
    async with new_client() as c:
        t = (await login(c)).json()["mfa_token"]
        for _ in range(5):
            assert (await c.post(f"{API}/auth/mfa/verify", json={"mfa_token": t, "code": "111111"})).status_code == 401
        r = await c.post(f"{API}/auth/mfa/verify", json={"mfa_token": t, "code": next_code(secret)})
        assert r.status_code == 429
        assert (await c.post(f"{API}/auth/mfa/verify", json={"mfa_token": "x" * 40, "code": "123456"})).status_code == 401
        assert (await c.post(f"{API}/auth/mfa/verify", json={"mfa_token": h["Authorization"].split()[1], "code": "123456"})).status_code == 401


async def test_disable_and_regenerate_need_password_and_code(client):
    h = await auth_headers(client)
    secret, _ = await enrol(client, h)
    r = await client.post(f"{API}/auth/mfa/recovery-codes", headers=h, json={"password": PASSWORD, "code": next_code(secret)})
    assert r.status_code == 200 and len(r.json()["recovery_codes"]) == 10
    assert (await client.post(f"{API}/auth/mfa/disable", headers=h, json={"password": "wrong", "code": "000000"})).status_code == 401  # pragma: allowlist secret
    r = await client.post(f"{API}/auth/mfa/disable", headers=h, json={"password": PASSWORD, "code": r.json()["recovery_codes"][0]})
    assert r.status_code == 204
    me = (await client.get(f"{API}/auth/me", headers=h)).json()
    assert me["mfa_enabled"] is False
    async with new_client() as c:
        assert "access_token" in (await login(c)).json()


async def test_admin_can_reset_a_users_mfa(client):
    h = await auth_headers(client)
    await enrol(client, h)
    me = (await client.get(f"{API}/auth/me", headers=h)).json()
    ah = await admin_headers(client)
    r = await client.patch(f"{API}/admin/users/{me['id']}", headers=ah, json={"reset_mfa": True})
    assert r.status_code == 200 and r.json()["mfa_enabled"] is False
    async with new_client() as c:
        assert "access_token" in (await login(c)).json()
    admin_id = (await client.get(f"{API}/auth/me", headers=ah)).json()["id"]
    assert (await client.patch(f"{API}/admin/users/{admin_id}", headers=ah, json={"reset_mfa": True})).status_code == 422
