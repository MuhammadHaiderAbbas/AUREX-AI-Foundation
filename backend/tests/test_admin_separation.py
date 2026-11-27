"""Administrators manage the platform and cannot trade; maintenance mode puts the site on hold."""

from app.ops import maintenance
from tests.conftest import API, PASSWORD, admin_headers, auth_headers, login


async def test_administrators_cannot_trade(client):
    ah = await admin_headers(client)
    for method, path, body in [("post", "/accounts", {"name": "Admin paper"}), ("get", "/accounts", None),
                               ("post", "/trading/orders", {"account_id": "00000000-0000-0000-0000-000000000000", "symbol": "BTC-USD",
                                                            "side": "BUY", "type": "MARKET", "quantity": "0.01"})]:
        r = await getattr(client, method)(f"{API}{path}", headers=ah, **({"json": body} if body else {}))
        assert r.status_code == 403 and r.json()["error"]["code"] == "admin_cannot_trade", (path, r.text)
    th = await auth_headers(client)
    assert (await client.post(f"{API}/accounts", headers=th, json={"name": "Trader paper"})).status_code == 201


async def test_maintenance_locks_traders_out_but_not_admins(client):
    ah = await admin_headers(client)
    th = await auth_headers(client, email="trader2@example.com")
    assert (await client.get(f"{API}/system/info")).json()["maintenance"]["enabled"] is False
    r = await client.post(f"{API}/admin/maintenance", headers=ah, json={"enabled": True, "message": "Upgrading", "until": "2030-01-01T10:00:00Z"})
    assert r.status_code == 200 and r.json()["enabled"] is True and r.json()["since"]
    maintenance.clear_cache()
    info = (await client.get(f"{API}/system/info")).json()["maintenance"]
    assert info["enabled"] and info["message"] == "Upgrading" and info["until"].startswith("2030-01-01")
    blocked = await client.get(f"{API}/accounts", headers=th)
    assert blocked.status_code == 503 and blocked.json()["error"]["code"] == "maintenance"
    assert (await login(client, email="trader2@example.com", password=PASSWORD)).status_code == 503
    assert (await client.get(f"{API}/admin/users", headers=ah)).status_code == 200          # admins keep access
    assert (await client.post(f"{API}/admin/maintenance", headers=th, json={"enabled": False})).status_code in (403, 503)
    audit = (await client.get(f"{API}/admin/audit?action=admin.maintenance.on", headers=ah)).json()
    assert audit["total"] == 1
    assert (await client.post(f"{API}/admin/maintenance", headers=ah, json={"enabled": False})).json()["enabled"] is False
    maintenance.clear_cache()
    assert (await client.get(f"{API}/accounts", headers=th)).status_code == 200
    assert (await login(client, email="trader2@example.com", password=PASSWORD)).status_code == 200


async def test_worker_pauses_bots_and_autopilot_on_hold(client):
    from app.database.session import SessionLocal
    from app.ops import worker
    async with SessionLocal() as db:
        await maintenance.set_state(db, True, None, None, None)
        await db.commit()
    try:
        assert (await worker.one_pass())["on_hold"] is True
    finally:
        async with SessionLocal() as db:
            await maintenance.set_state(db, False, None, None, None)
            await db.commit()
