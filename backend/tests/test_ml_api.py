from sqlalchemy import text

from app.database.session import SessionLocal
from tests.conftest import API, admin_headers, auth_headers

TRAIN = {"symbol": "BTC-USD", "algorithm": "logistic", "horizon": 4, "days": 60}


async def force_eligible(version_id: str):
    """Simulate a version that passed every gate on real market data."""
    async with SessionLocal() as db:
        await db.execute(text("UPDATE model_versions SET eligible = true, data_source = 'coinbase', "
                              "eligibility_note = 'All validation gates passed' WHERE id = :id"), {"id": version_id})
        await db.commit()


async def test_training_is_admin_only_and_never_auto_promotes(client):
    uh = await auth_headers(client)
    algos = (await client.get(f"{API}/ml/algorithms", headers=uh)).json()
    assert [a["key"] for a in algos] == ["logistic", "random_forest", "lightgbm"]
    assert (await client.post(f"{API}/ml/train", headers=uh, json=TRAIN)).status_code == 403

    ah = await admin_headers(client)
    r = await client.post(f"{API}/ml/train", headers=ah, json=TRAIN)
    assert r.status_code == 201, r.text
    v = r.json()
    assert v["status"] == "candidate" and v["version"] == 1 and v["data_source"] == "synthetic"
    assert v["eligible"] is False and "Trained on real market data" in v["eligibility_note"]
    assert len(v["metrics"]["folds"]) == 5 and v["metrics"]["calibration"]
    assert set(v["metrics"]["curves"]) == {"times", "model", "buy_hold", "momentum"}
    assert len(v["features"]) == 14 and abs(sum(v["feature_importance"].values()) - 1) < 0.01
    assert v["evaluations"][0]["kind"] == "walk_forward" and len(v["artifact_sha256"]) == 64

    r = await client.post(f"{API}/ml/versions/{v['id']}/promote", headers=ah)
    assert r.status_code == 422 and "not eligible" in r.json()["error"]["message"]
    assert any(g["name"] == "Trained on real market data" for g in r.json()["error"]["details"])
    models = (await client.get(f"{API}/ml/models", headers=uh)).json()
    assert models[0]["versions"][0]["status"] == "candidate"
    assert (await client.get(f"{API}/ml/champion?symbol=BTC-USD", headers=uh)).status_code == 404
    bad = await client.post(f"{API}/ml/train", headers=ah, json={**TRAIN, "algorithm": "lstm"})
    assert bad.status_code == 422


async def test_promotion_lifecycle_and_ml_agent(client):
    ah = await admin_headers(client)
    th = await auth_headers(client, email="quant@example.com")          # administrators do not trade: a trader runs the desk
    acct = (await client.post(f"{API}/accounts", headers=th, json={"name": "Paper"})).json()
    v1 = (await client.post(f"{API}/ml/train", headers=ah, json=TRAIN)).json()
    await force_eligible(v1["id"])
    r = await client.post(f"{API}/ml/versions/{v1['id']}/promote", headers=ah)
    assert r.status_code == 200 and r.json()["status"] == "champion"
    assert (await client.post(f"{API}/ml/versions/{v1['id']}/promote", headers=ah)).status_code == 422

    run = (await client.post(f"{API}/ai/run", headers=th, json={"symbol": "BTC-USD", "account_id": acct["id"]})).json()
    ml = next(f for f in run["findings"] if f["agent"] == "ml")
    assert ml["status"] == "ok" and "P(up over 4h)" in ml["summary"]
    assert run["weights"]["ml"] == 0.0          # advisory until an admin assigns weight
    assert run["context"]["ml_champion"]["version"] == 1

    v2 = (await client.post(f"{API}/ml/train", headers=ah, json={**TRAIN, "algorithm": "lightgbm"})).json()
    await force_eligible(v2["id"])
    assert (await client.post(f"{API}/ml/versions/{v2['id']}/promote", headers=ah)).status_code == 200
    v1_after = (await client.get(f"{API}/ml/versions/{v1['id']}", headers=ah)).json()
    assert v1_after["status"] == "retired" and v1_after["retired_at"]
    champ = (await client.get(f"{API}/ml/champion?symbol=BTC-USD", headers=ah)).json()
    assert champ["id"] == v2["id"]
    audit = (await client.get(f"{API}/admin/audit?action=ml.promote", headers=ah)).json()
    assert audit["total"] == 2 and audit["items"][0]["details"]["retired"] == v1["id"]

    assert (await client.post(f"{API}/ml/versions/{v2['id']}/retire", headers=ah)).status_code == 200
    run = (await client.post(f"{API}/ai/run", headers=ah, json={"symbol": "BTC-USD"})).json()
    ml = next(f for f in run["findings"] if f["agent"] == "ml")
    assert ml["status"] == "abstain" and "No promoted champion" in ml["summary"]


async def test_drift_check_reduces_eligibility(client):
    ah = await admin_headers(client)
    v = (await client.post(f"{API}/ml/train", headers=ah, json=TRAIN)).json()
    await force_eligible(v["id"])
    await client.post(f"{API}/ml/versions/{v['id']}/promote", headers=ah)

    ok = (await client.post(f"{API}/ml/versions/{v['id']}/drift-check?days=30", headers=ah)).json()
    assert ok["kind"] == "drift_check" and ok["status"] in ("ok", "warning")
    assert set(ok["metrics"]["psi"]) == set(v["features"])

    async with SessionLocal() as db:    # pretend training saw a very different world
        await db.execute(text(
            "UPDATE model_versions SET reference = (SELECT jsonb_object_agg(key, jsonb_set(value::jsonb, "
            "'{edges}', '[100,101,102,103,104,105,106,107,108]'::jsonb)) FROM json_each(reference)) WHERE id = :id"),
            {"id": v["id"]})
        await db.commit()
    bad = (await client.post(f"{API}/ml/versions/{v['id']}/drift-check?days=30", headers=ah)).json()
    assert bad["status"] == "drift" and bad["metrics"]["max_psi"] > 0.25
    after = (await client.get(f"{API}/ml/versions/{v['id']}", headers=ah)).json()
    assert after["status"] == "champion" and after["eligible"] is False      # kept, but not trusted
    assert after["eligibility_note"].startswith("Drift detected")
    run = (await client.post(f"{API}/ai/run", headers=ah, json={"symbol": "BTC-USD"})).json()
    ml = next(f for f in run["findings"] if f["agent"] == "ml")
    assert ml["status"] == "abstain" and "not eligible" in ml["summary"]
    uh = await auth_headers(client)
    assert (await client.post(f"{API}/ml/versions/{v['id']}/drift-check", headers=uh)).status_code == 403


async def test_tampered_artifact_is_never_loaded(client):
    ah = await admin_headers(client)
    v = (await client.post(f"{API}/ml/train", headers=ah, json=TRAIN)).json()
    await force_eligible(v["id"])
    await client.post(f"{API}/ml/versions/{v['id']}/promote", headers=ah)
    async with SessionLocal() as db:
        await db.execute(text("UPDATE model_versions SET artifact_sha256 = repeat('0', 64) WHERE id = :id"),
                         {"id": v["id"]})
        await db.commit()
    run = (await client.post(f"{API}/ai/run", headers=ah, json={"symbol": "BTC-USD"})).json()
    ml = next(f for f in run["findings"] if f["agent"] == "ml")
    assert ml["status"] == "abstain" and "integrity" in ml["summary"]


async def test_artifact_swapped_with_matching_sha256_is_refused(client):
    """A database writer can recompute a plain SHA-256, but not the server-keyed HMAC."""
    import hashlib
    import pickle

    ah = await admin_headers(client)
    v = (await client.post(f"{API}/ml/train", headers=ah, json=TRAIN)).json()
    await force_eligible(v["id"])
    await client.post(f"{API}/ml/versions/{v['id']}/promote", headers=ah)
    evil = pickle.dumps({"not": "a model"})
    async with SessionLocal() as db:
        await db.execute(text("UPDATE model_versions SET artifact = :a, artifact_sha256 = :h WHERE id = :id"),
                         {"a": evil, "h": hashlib.sha256(evil).hexdigest(), "id": v["id"]})
        await db.commit()
    run = (await client.post(f"{API}/ai/run", headers=ah, json={"symbol": "BTC-USD"})).json()
    ml = next(f for f in run["findings"] if f["agent"] == "ml")
    assert ml["status"] == "abstain" and "integrity" in ml["summary"]
    async with SessionLocal() as db:   # unsigned legacy artifacts are refused too
        await db.execute(text("UPDATE model_versions SET artifact_hmac = NULL WHERE id = :id"), {"id": v["id"]})
        await db.commit()
    from app.ml.service import _model_cache
    _model_cache.clear()
    run = (await client.post(f"{API}/ai/run", headers=ah, json={"symbol": "BTC-USD"})).json()
    assert next(f for f in run["findings"] if f["agent"] == "ml")["status"] == "abstain"
