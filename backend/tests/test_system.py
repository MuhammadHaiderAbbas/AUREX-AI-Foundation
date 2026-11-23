from tests.conftest import API


async def test_health(client):
    r = await client.get(f"{API}/system/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok", "database": "ok"}
    assert r.headers["x-content-type-options"] == "nosniff"
    assert len(r.headers["x-request-id"]) >= 8


async def test_info_reports_paper_only(client):
    body = (await client.get(f"{API}/system/info")).json()
    assert body["trading_mode"] == "PAPER"
    assert body["live_trading_enabled"] is False


async def test_request_id_is_sanitised(client):
    r = await client.get(f"{API}/system/health", headers={"X-Request-ID": "bad id\nINJECT"})
    assert "\n" not in r.headers["x-request-id"] and " " not in r.headers["x-request-id"]
    r = await client.get(f"{API}/system/health", headers={"X-Request-ID": "trace-12345678"})
    assert r.headers["x-request-id"] == "trace-12345678"


async def test_openapi_docs_available(client):
    r = await client.get(f"{API}/openapi.json")
    assert r.status_code == 200
    paths = r.json()["paths"]
    assert f"{API}/accounts" in paths and f"{API}/auth/login" in paths
