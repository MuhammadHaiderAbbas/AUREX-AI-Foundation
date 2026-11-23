from sqlalchemy import text

from app.database.session import SessionLocal
from tests.conftest import API, admin_headers, auth_headers, new_client


async def test_admin_endpoints_require_admin(client):
    h = await auth_headers(client)
    for path in ["/admin/users", "/admin/audit", "/admin/audit/verify"]:
        r = await client.get(f"{API}{path}", headers=h)
        assert r.status_code == 403, path


async def test_audit_trail_records_actions_and_verifies(client):
    async with new_client() as user_client:
        h = await auth_headers(user_client)
        r = await user_client.post(f"{API}/accounts", headers=h, json={"name": "a"})
        aid = r.json()["id"]
        await user_client.post(f"{API}/accounts/{aid}/deposits", headers=h, json={"amount": "5"})
        await user_client.post(f"{API}/auth/login",
                               json={"email": "trader@example.com", "password": "nope"})

    ah = await admin_headers(client)
    page = (await client.get(f"{API}/admin/audit?limit=200", headers=ah)).json()
    actions = [row["action"] for row in page["items"]]
    for expected in ["auth.register", "auth.login", "account.paper.create", "wallet.deposit"]:
        assert expected in actions
    failures = [r for r in page["items"] if r["outcome"] == "failure"]
    assert failures and failures[0]["details"]["reason"] == "invalid_credentials"

    filtered = (await client.get(f"{API}/admin/audit?action=wallet.deposit", headers=ah)).json()
    assert filtered["total"] == 1 and filtered["items"][0]["details"]["amount"] == "5"

    v = (await client.get(f"{API}/admin/audit/verify", headers=ah)).json()
    assert v["valid"] is True and v["records_checked"] == page["total"]


async def test_audit_tampering_is_detected(client):
    ah = await admin_headers(client)
    await auth_headers(client, email="victim@example.com")
    async with SessionLocal() as db:
        # Simulate a privileged attacker bypassing the append-only trigger.
        await db.execute(text("ALTER TABLE audit_logs DISABLE TRIGGER trg_audit_logs_append_only"))
        await db.execute(text(
            "UPDATE audit_logs SET details = '{\"forged\": true}' WHERE action = 'auth.register'"))
        await db.execute(text("ALTER TABLE audit_logs ENABLE TRIGGER trg_audit_logs_append_only"))
        await db.commit()
    v = (await client.get(f"{API}/admin/audit/verify", headers=ah)).json()
    assert v["valid"] is False and v["reason"] == "record hash mismatch"


async def test_audit_log_is_append_only(client):
    await auth_headers(client)
    async with SessionLocal() as db:
        try:
            await db.execute(text("DELETE FROM audit_logs"))
            raise AssertionError("delete should fail")
        except Exception as e:  # noqa: BLE001
            assert "append-only" in str(e)


async def test_admin_user_management(client):
    ah = await admin_headers(client)
    async with new_client() as uc:
        uh = await auth_headers(uc, email="u@example.com")
        users = (await client.get(f"{API}/admin/users", headers=ah)).json()
        assert users["total"] == 2
        uid = next(u["id"] for u in users["items"] if u["email"] == "u@example.com")
        admin_id = next(u["id"] for u in users["items"] if u["role"] == "admin")

        # cannot demote yourself
        r = await client.patch(f"{API}/admin/users/{admin_id}", headers=ah, json={"role": "user"})
        assert r.status_code == 422

        # disabling a user revokes their sessions immediately
        r = await client.patch(f"{API}/admin/users/{uid}", headers=ah, json={"is_active": False})
        assert r.status_code == 200 and r.json()["is_active"] is False
        assert (await uc.get(f"{API}/auth/me", headers=uh)).status_code == 401
        r = await uc.post(f"{API}/auth/login",
                          json={"email": "u@example.com", "password": "Correct-Horse-42"})
        assert r.status_code == 403

        r = await client.patch(f"{API}/admin/users/{uid}", headers=ah,
                               json={"is_active": True, "role": "admin"})
        assert r.json()["role"] == "admin"
