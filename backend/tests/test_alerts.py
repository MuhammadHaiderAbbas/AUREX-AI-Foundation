"""Price alerts: create, validate, trigger on live quotes, mark seen, cancel, privacy."""

from app.alerts import check_all, crossed
from app.database.session import SessionLocal
from tests.conftest import API, admin_headers, auth_headers, new_client
from tests.test_trading import fake_quotes, set_price  # noqa: F401  (autouse fixture)


def test_crossed():
    from decimal import Decimal as D
    assert crossed("ABOVE", D("100"), D("100")) and crossed("ABOVE", D("100"), D("101")) and not crossed("ABOVE", D("100"), D("99"))
    assert crossed("BELOW", D("100"), D("99")) and not crossed("BELOW", D("100"), D("101"))


async def test_alert_lifecycle(client):
    h = await auth_headers(client)
    set_price("BTC-USD", "50000")
    up = (await client.post(f"{API}/alerts", headers=h, json={"symbol": "BTC-USD", "direction": "ABOVE", "price": "55000", "note": "breakout"})).json()
    down = (await client.post(f"{API}/alerts", headers=h, json={"symbol": "BTC-USD", "direction": "BELOW", "price": "45000"})).json()
    assert up["status"] == "ACTIVE" and up["note"] == "breakout"
    assert (await client.post(f"{API}/alerts", headers=h, json={"symbol": "NOPE", "direction": "ABOVE", "price": "1"})).status_code == 404
    assert (await client.post(f"{API}/alerts", headers=h, json={"symbol": "BTC-USD", "direction": "SIDEWAYS", "price": "1"})).status_code == 422
    assert (await client.post(f"{API}/alerts", headers=h, json={"symbol": "BTC-USD", "direction": "ABOVE", "price": "0"})).status_code == 422

    async with SessionLocal() as db:
        assert await check_all(db) == 0                 # nothing crossed yet
        await db.commit()
    set_price("BTC-USD", "56000")
    async with SessionLocal() as db:
        assert await check_all(db) == 1
        await db.commit()
    items = {a["id"]: a for a in (await client.get(f"{API}/alerts", headers=h)).json()}
    assert items[up["id"]]["status"] == "TRIGGERED" and items[up["id"]]["triggered_price"].startswith("56000") and items[up["id"]]["seen_at"] is None
    assert items[down["id"]]["status"] == "ACTIVE"
    assert (await client.post(f"{API}/alerts/seen", headers=h)).status_code == 204
    assert [a for a in (await client.get(f"{API}/alerts", headers=h)).json() if a["id"] == up["id"]][0]["seen_at"]
    assert (await client.delete(f"{API}/alerts/{down['id']}", headers=h)).status_code == 204
    assert [a for a in (await client.get(f"{API}/alerts", headers=h)).json() if a["id"] == down["id"]][0]["status"] == "CANCELLED"

    async with new_client() as other:
        oh = await auth_headers(other, email="other@example.com")
        assert (await other.get(f"{API}/alerts", headers=oh)).json() == []
        assert (await other.delete(f"{API}/alerts/{up['id']}", headers=oh)).status_code == 404
    ah = await admin_headers(client)
    assert (await client.get(f"{API}/alerts", headers=ah)).status_code == 403          # administrators do not trade


async def test_stale_quotes_do_not_trigger(client):
    h = await auth_headers(client, email="stale@example.com")
    await client.post(f"{API}/alerts", headers=h, json={"symbol": "AAPL", "direction": "ABOVE", "price": "100"})
    set_price("AAPL", "200", stale=True)
    async with SessionLocal() as db:
        assert await check_all(db) == 0
        await db.commit()


async def test_worker_runs_the_alert_check(client):
    from app.ops import worker
    h = await auth_headers(client, email="w@example.com")
    await client.post(f"{API}/alerts", headers=h, json={"symbol": "BTC-USD", "direction": "BELOW", "price": "60000"})
    set_price("BTC-USD", "50000")
    assert (await worker.one_pass())["alerts"] == 1
