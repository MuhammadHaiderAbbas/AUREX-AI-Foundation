"""Phase 11: transport controls, authentication hardening, key rotation, audit export."""

import json
from datetime import UTC, datetime, timedelta

import httpx
import jwt
import pytest

from app.core import password_policy
from app.core.config import get_settings
from app.core.security import key_id, sign_artifact, verify_artifact
from app.main import create_app
from app.services.audit_service import verify_export
from tests.conftest import API, PASSWORD, admin_headers, auth_headers, login, new_client, register


def settings_env(monkeypatch, **env):
    for k, v in env.items():
        monkeypatch.setenv(f"AUREX_{k.upper()}", str(v))
    get_settings.cache_clear()


# -- headers and docs ----------------------------------------------------------------------------
async def test_api_security_headers(client):
    r = await client.get(f"{API}/system/health")
    h = r.headers
    assert h["content-security-policy"].startswith("default-src 'none'") and "frame-ancestors 'none'" in h["content-security-policy"]
    assert h["x-content-type-options"] == "nosniff" and h["x-frame-options"] == "DENY"
    assert h["cross-origin-opener-policy"] == "same-origin" and h["cross-origin-resource-policy"] == "same-origin"
    assert "camera=()" in h["permissions-policy"] and h["cache-control"] == "no-store"
    assert "strict-transport-security" not in h          # only in staging/production
    assert (await client.get(f"{API}/docs")).status_code == 200    # development/test default


async def test_docs_can_be_disabled(monkeypatch):
    settings_env(monkeypatch, expose_api_docs="false")
    app = create_app()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://aurex.test") as c:
        assert (await c.get(f"{API}/docs")).status_code == 404
        assert (await c.get(f"{API}/openapi.json")).status_code == 404
        assert (await c.get(f"{API}/system/health")).status_code == 200


# -- body size and rate limits --------------------------------------------------------------------
async def test_oversized_bodies_are_rejected(client):
    h = await auth_headers(client)
    big = json.dumps({"name": "x" * (1_048_576 + 10)})
    r = await client.post(f"{API}/accounts", headers={**h, "Content-Type": "application/json"}, content=big)
    assert r.status_code == 413 and r.json()["error"]["code"] == "payload_too_large"

    async def chunks():                                # no Content-Length: counted as it streams
        for _ in range(20):
            yield b"x" * 100_000
    r = await client.post(f"{API}/accounts", headers={**h, "Content-Type": "application/json"}, content=chunks())
    assert r.status_code == 413
    ah = await admin_headers(client)                   # uploads get the larger limit
    r = await client.post(f"{API}/research/documents/upload", headers=ah,
                          files={"file": ("a.txt", b"x" * 2_000_000, "text/plain")}, data={"source_name": "t"})
    assert r.status_code != 413


async def test_global_rate_limit(monkeypatch, client):
    settings_env(monkeypatch, api_rate_limit_per_minute=5)
    for _ in range(5):
        assert (await client.get(f"{API}/system/info")).status_code == 200
    r = await client.get(f"{API}/system/info")
    assert r.status_code == 429 and int(r.headers["retry-after"]) >= 0 and r.json()["error"]["code"] == "rate_limited"
    assert (await client.get(f"{API}/system/health")).status_code == 200     # health checks are exempt


# -- authentication ----------------------------------------------------------------------------------
@pytest.mark.parametrize("pw,ok", [
    ("Correct-Horse-42", True), ("Tr0ub4dor&3-plus", True),
    ("Password123!", False), ("P@ssw0rd2026!", False), ("Qwerty12345!!", False), ("Welcome2026!!", False),
    ("Aaaaaaaaaaaa1!", False), ("Xk9!1234567890", False), ("short1A!", False), ("alllowercaseonly", False),
])
def test_password_policy(pw, ok):
    assert (password_policy.problems(pw) == []) is ok, password_policy.problems(pw)


def test_password_must_not_contain_personal_info():
    assert password_policy.problems("Mustafa-Rocks-99", name="Mustafa Khan")
    assert password_policy.problems("Zx-traderjoe-99", email="traderjoe@example.com")
    assert not password_policy.problems("Correct-Horse-42", email="traderjoe@example.com", name="Joe Bloggs")


async def test_register_and_change_password_enforce_policy(client):
    r = await register(client, email="pat@example.com", name="Pat Example", password="Password123!")  # pragma: allowlist secret
    assert r.status_code == 422
    r = await register(client, email="pat@example.com", name="Pat Example", password="Example-Pat-77")  # pragma: allowlist secret
    assert r.status_code == 422 and "name or email" in r.text
    h = await auth_headers(client, email="pat@example.com")
    for new, msg in [(PASSWORD, "different"), ("Welcome2026!!", "too common")]:
        r = await client.post(f"{API}/auth/password", headers=h, json={"current_password": PASSWORD, "new_password": new})
        assert r.status_code == 422 and msg in r.text, r.text


async def test_account_lockout_across_addresses(monkeypatch, client):
    settings_env(monkeypatch, login_rate_limit_attempts=100, login_lockout_failures=3)
    await register(client)
    for _ in range(3):
        assert (await login(client, password="Wrong-Password-1")).status_code == 401  # pragma: allowlist secret
    r = await login(client)                              # even the right password is refused now
    assert r.status_code == 429 and "temporarily locked" in r.text
    ah = await admin_headers(client)
    audit = (await client.get(f"{API}/admin/audit?action=auth.lockout", headers=ah)).json()
    assert audit["total"] == 1 and audit["items"][0]["details"]["failures"] == 3


async def test_registration_rate_limit(monkeypatch, client):
    settings_env(monkeypatch, registrations_per_ip_per_hour=2)
    assert (await register(client, email="a1@example.com")).status_code == 201
    assert (await register(client, email="a2@example.com")).status_code == 201
    assert (await register(client, email="a3@example.com")).status_code == 429


async def test_cookie_endpoints_refuse_cross_site_origins(client):
    await auth_headers(client)
    r = await client.post(f"{API}/auth/refresh", headers={"Origin": "https://evil.example"})
    assert r.status_code == 403
    r = await client.post(f"{API}/auth/logout", headers={"Origin": "https://evil.example"})
    assert r.status_code == 403
    r = await client.post(f"{API}/auth/refresh", headers={"Origin": "http://aurex.test"})   # same site
    assert r.status_code == 200
    assert (await client.post(f"{API}/auth/refresh", headers={"Origin": "http://localhost:5173"})).status_code == 200


async def test_session_management(client):
    h1 = await auth_headers(client)
    async with new_client() as other:
        r = await login(other)
        h2 = {"Authorization": f"Bearer {r.json()['access_token']}"}
        sessions = (await client.get(f"{API}/auth/sessions", headers=h1)).json()
        assert len(sessions) == 2 and sum(s["current"] for s in sessions) == 1
        other_id = next(s["id"] for s in sessions if not s["current"])
        assert (await client.post(f"{API}/auth/sessions/{other_id}/revoke", headers=h1)).status_code == 204
        assert (await other.get(f"{API}/auth/me", headers=h2)).status_code == 401
        assert (await other.post(f"{API}/auth/refresh")).status_code == 401      # its refresh token is dead too
        r = await login(other)
        h3 = {"Authorization": f"Bearer {r.json()['access_token']}"}
        assert (await client.post(f"{API}/auth/sessions/revoke-others", headers=h1)).status_code == 204
        assert (await other.get(f"{API}/auth/me", headers=h3)).status_code == 401
    assert (await client.get(f"{API}/auth/me", headers=h1)).status_code == 200
    assert len((await client.get(f"{API}/auth/sessions", headers=h1)).json()) == 1
    async with new_client() as stranger:
        sh = await auth_headers(stranger, email="stranger@example.com")
        mine = (await client.get(f"{API}/auth/sessions", headers=h1)).json()[0]["id"]
        assert (await stranger.post(f"{API}/auth/sessions/{mine}/revoke", headers=sh)).status_code == 404


# -- keys ------------------------------------------------------------------------------------------------
async def test_jwt_key_rotation(monkeypatch, client):
    old, new = "a" * 40, "b" * 40
    settings_env(monkeypatch, jwt_secret=old)
    h = await auth_headers(client)
    token = h["Authorization"].split()[1]
    assert jwt.get_unverified_header(token)["kid"] == key_id(old)
    settings_env(monkeypatch, jwt_secret=new, jwt_previous_secrets=old)
    assert (await client.get(f"{API}/auth/me", headers=h)).status_code == 200          # still valid mid-rotation
    settings_env(monkeypatch, jwt_secret=new, jwt_previous_secrets="")
    assert (await client.get(f"{API}/auth/me", headers=h)).status_code == 401          # retired key
    payload = jwt.decode(token, old, algorithms=["HS256"])
    forged = jwt.encode({**payload, "exp": int((datetime.now(UTC) + timedelta(minutes=5)).timestamp())}, "c" * 40,
                        algorithm="HS256", headers={"kid": key_id("c" * 40)})
    assert (await client.get(f"{API}/auth/me", headers={"Authorization": f"Bearer {forged}"})).status_code == 401
    unsigned = jwt.encode(payload, None, algorithm="none")
    assert (await client.get(f"{API}/auth/me", headers={"Authorization": f"Bearer {unsigned}"})).status_code == 401


def test_artifact_signatures():
    sig = sign_artifact(b"model-bytes")
    assert verify_artifact(b"model-bytes", sig) and len(sig) == 64
    assert not verify_artifact(b"model-bytez", sig) and not verify_artifact(b"model-bytes", None)


# -- audit export -----------------------------------------------------------------------------------------
async def test_audit_export_verifies_offline_and_detects_tampering(client):
    await auth_headers(client)
    ah = await admin_headers(client)
    uh = await auth_headers(client, email="plain@example.com")
    assert (await client.get(f"{API}/admin/audit/export", headers=uh)).status_code == 403
    r = await client.get(f"{API}/admin/audit/export", headers=ah)
    assert r.status_code == 200 and r.headers["content-disposition"].startswith('attachment; filename="aurex-audit-')
    lines = r.text.splitlines()
    header = json.loads(lines[0])
    assert header["format"] == "aurex-audit-export/1" and header["records"] == len(lines) - 1 >= 5
    assert json.loads(lines[-1])["action"] == "admin.audit.export"      # the export audits itself first
    assert verify_export(lines) == {"valid": True, "records_checked": len(lines) - 1, "last_hash": json.loads(lines[-1])["hash"]}

    rec = json.loads(lines[2])
    rec["details"] = {"forged": True}
    assert verify_export([*lines[:2], json.dumps(rec), *lines[3:]])["reason"] == "record hash mismatch"
    assert verify_export([*lines[:2], *lines[3:]])["reason"] == "gap in record ids"
    assert verify_export(lines[:-1])["reason"] == "record count does not match header"
    assert verify_export([])["valid"] is False

    part = (await client.get(f"{API}/admin/audit/export?from_id=3", headers=ah)).text.splitlines()
    assert json.loads(part[0])["anchor_prev_hash"] == json.loads(lines[2])["hash"]
    assert verify_export(part)["valid"] is True


async def test_cli_audit_roundtrip(tmp_path, client):
    from app.cli import audit_verify_file
    ah = await admin_headers(client)
    path = tmp_path / "audit.jsonl"
    path.write_text((await client.get(f"{API}/admin/audit/export", headers=ah)).text)
    assert audit_verify_file(str(path)) == 0
    path.write_text(path.read_text().replace('"outcome": "success"', '"outcome": "failure"', 1))
    assert audit_verify_file(str(path)) == 1


async def test_download_filenames_never_echo_raw_input(client):
    h = await auth_headers(client)
    acct = (await client.post(f"{API}/accounts", headers=h, json={"name": 'Q1 "growth"; x=1 / ../ok'})).json()
    r = await client.get(f"{API}/analytics/accounts/{acct['id']}/report?download=true", headers=h)
    cd = r.headers["content-disposition"]
    assert cd.startswith('attachment; filename="aurex-report-Q1_growth_x_1_ok-30d-') and cd.count('"') == 2
