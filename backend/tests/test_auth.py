import os

from app.core.config import get_settings
from tests.conftest import API, PASSWORD, auth_headers, login, new_client, register


async def test_register_and_login(client):
    r = await register(client, email="Trader@Example.com")
    assert r.status_code == 201
    body = r.json()
    assert body["email"] == "trader@example.com"
    assert body["role"] == "user"
    assert "password" not in str(body).lower()

    r = await login(client, email="TRADER@example.com")
    assert r.status_code == 200
    data = r.json()
    assert data["token_type"] == "bearer" and data["expires_in"] == 900
    cookie = r.headers["set-cookie"]
    assert "aurex_refresh=" in cookie and "HttpOnly" in cookie
    assert "samesite=strict" in cookie.lower() and "Path=/api/v1/auth" in cookie

    me = await client.get(f"{API}/auth/me",
                          headers={"Authorization": f"Bearer {data['access_token']}"})
    assert me.status_code == 200 and me.json()["email"] == "trader@example.com"


async def test_duplicate_email_rejected(client):
    assert (await register(client)).status_code == 201
    r = await register(client, email="TRADER@example.com")
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "conflict"


async def test_weak_passwords_rejected(client):
    for pw in ["short1A!", "alllowercaseletters", "NoDigitsOrSymbolsHere"]:
        r = await register(client, password=pw)
        assert r.status_code == 422, pw
        assert r.json()["error"]["code"] == "validation_error"


async def test_invalid_credentials(client):
    await register(client)
    r = await login(client, password="Wrong-Password-99")
    assert r.status_code == 401
    r = await login(client, email="nobody@example.com")
    assert r.status_code == 401
    assert r.json()["error"]["message"] == "Invalid email or password"


async def test_login_rate_limited(client):
    await register(client)
    for _ in range(5):
        assert (await login(client, password="Wrong-Password-99")).status_code == 401
    r = await login(client)  # even the right password is blocked within the window
    assert r.status_code == 429


async def test_protected_route_requires_token(client):
    assert (await client.get(f"{API}/auth/me")).status_code == 401
    r = await client.get(f"{API}/auth/me", headers={"Authorization": "Bearer not-a-jwt"})
    assert r.status_code == 401


async def test_refresh_rotates_and_detects_reuse(client):
    await register(client)
    r = await login(client)
    old_cookie = client.cookies.get("aurex_refresh")

    r = await client.post(f"{API}/auth/refresh")
    assert r.status_code == 200
    new_access = r.json()["access_token"]
    new_cookie = client.cookies.get("aurex_refresh")
    assert new_cookie and new_cookie != old_cookie

    # Replaying the rotated token revokes the whole session family.
    async with new_client() as attacker:
        attacker.cookies.set("aurex_refresh", old_cookie, domain="aurex.test",
                             path="/api/v1/auth")
        assert (await attacker.post(f"{API}/auth/refresh")).status_code == 401

    assert (await client.post(f"{API}/auth/refresh")).status_code == 401
    me = await client.get(f"{API}/auth/me", headers={"Authorization": f"Bearer {new_access}"})
    assert me.status_code == 401


async def test_logout_revokes_access_token(client):
    headers = await auth_headers(client)
    assert (await client.get(f"{API}/auth/me", headers=headers)).status_code == 200
    r = await client.post(f"{API}/auth/logout")
    assert r.status_code == 204
    assert (await client.get(f"{API}/auth/me", headers=headers)).status_code == 401
    assert (await client.post(f"{API}/auth/refresh")).status_code == 401


async def test_change_password(client):
    headers = await auth_headers(client)
    r = await client.post(f"{API}/auth/password", headers=headers,
                          json={"current_password": "wrong", "new_password": "New-Password-123"})
    assert r.status_code == 401
    r = await client.post(f"{API}/auth/password", headers=headers,
                          json={"current_password": PASSWORD, "new_password": "New-Password-123"})
    assert r.status_code == 204
    assert (await login(client)).status_code == 401
    assert (await login(client, password="New-Password-123")).status_code == 200


async def test_registration_can_be_disabled(client):
    os.environ["AUREX_ALLOW_REGISTRATION"] = "false"
    get_settings.cache_clear()
    try:
        r = await register(client)
        assert r.status_code == 403
    finally:
        os.environ["AUREX_ALLOW_REGISTRATION"] = "true"
        get_settings.cache_clear()


async def test_user_settings(client):
    headers = await auth_headers(client)
    r = await client.get(f"{API}/users/me/settings", headers=headers)
    assert r.status_code == 200 and r.json()["timezone"] == "Europe/London"
    r = await client.patch(f"{API}/users/me/settings", headers=headers,
                           json={"base_currency": "GBP", "timezone": "America/New_York"})
    assert r.status_code == 200
    assert r.json()["base_currency"] == "GBP" and r.json()["timezone"] == "America/New_York"
    r = await client.patch(f"{API}/users/me/settings", headers=headers,
                           json={"timezone": "Mars/Olympus"})
    assert r.status_code == 422


async def test_my_activity_is_scoped_to_caller(client):
    headers = await auth_headers(client)
    async with new_client() as other:
        await auth_headers(other, email="other@example.com")
    rows = (await client.get(f"{API}/users/me/activity", headers=headers)).json()
    assert [r["action"] for r in rows] == ["auth.login", "auth.register"]
