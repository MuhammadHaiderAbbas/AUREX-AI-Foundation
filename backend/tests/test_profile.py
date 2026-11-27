"""Profile: edit name, export my data, close my account."""

from tests.conftest import API, PASSWORD, auth_headers, login


async def test_edit_name_and_export(client):
    h = await auth_headers(client, email="me@example.com")
    r = await client.patch(f"{API}/users/me", headers=h, json={"full_name": "  New   Name "})
    assert r.status_code == 200 and r.json()["full_name"] == "New Name"
    assert (await client.patch(f"{API}/users/me", headers=h, json={"full_name": "   "})).status_code == 422
    acct = (await client.post(f"{API}/accounts", headers=h, json={"name": "Mine", "base_currency": "GBP", "starting_balance": "100"})).json()
    r = await client.get(f"{API}/users/me/export", headers=h)
    assert r.status_code == 200 and "attachment" in r.headers["content-disposition"]
    data = r.json()
    assert data["profile"]["email"] == "me@example.com" and data["profile"]["full_name"] == "New Name"
    assert [a["id"] for a in data["accounts"]] == [acct["id"]]
    assert {"orders", "executions", "positions", "binary_contracts", "activity", "settings"} <= set(data)
    assert any(a["action"] == "user.profile.update" for a in data["activity"])


async def test_close_account(client):
    h = await auth_headers(client, email="leaver@example.com")
    await client.post(f"{API}/accounts", headers=h, json={"name": "Mine"})
    assert (await client.post(f"{API}/users/me/close", headers=h, json={"password": "wrong-password"})).status_code == 403
    assert (await client.post(f"{API}/users/me/close", headers=h, json={"password": PASSWORD})).status_code == 204
    assert (await client.get(f"{API}/accounts", headers=h)).status_code == 401          # sessions revoked
    assert (await login(client, email="leaver@example.com")).status_code == 401           # personal details removed
    again = await client.post(f"{API}/auth/register", json={"email": "leaver@example.com", "full_name": "Back Again", "password": PASSWORD})
    assert again.status_code == 201                                                       # the email can be used again
