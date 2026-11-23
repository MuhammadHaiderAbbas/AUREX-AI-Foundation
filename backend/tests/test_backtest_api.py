from tests.conftest import API, admin_headers, auth_headers, new_client


async def test_strategy_catalogue(client):
    h = await auth_headers(client)
    rows = (await client.get(f"{API}/backtests/strategies", headers=h)).json()
    assert [r["key"] for r in rows] == ["sma_crossover", "rsi_reversion", "donchian_breakout", "agent_consensus"]
    assert rows[0]["defaults"] == {"fast": 20, "slow": 50} and rows[0]["grid_size"] == 6


async def test_run_backtest_end_to_end(client):
    h = await auth_headers(client)
    body = {"strategy": "sma_crossover", "symbol": "BTC-USD", "days": 60, "optimise": True,
            "costs": {"fee_bps": 5, "latency_bars": 2}}
    r = await client.post(f"{API}/backtests", headers=h, json=body)
    assert r.status_code == 201, r.text
    bt = r.json()
    res = bt["result"]
    assert bt["data_source"] == "synthetic" and res["warnings"][0].startswith("Backtested on synthetic data")
    assert bt["config"]["costs"]["fee_bps"] == 5 and bt["config"]["costs"]["latency_bars"] == 2
    assert bt["config"]["risk"]["max_drawdown"] == 0.10 and bt["config"]["risk"]["daily_loss_limit"] == 0.02
    for seg in ("in_sample", "out_of_sample"):
        assert {"strategy", "buy_hold"} <= set(res[seg])
        assert {"sharpe", "sortino", "max_drawdown", "calmar", "profit_factor", "fees"} <= set(res[seg]["strategy"])
    assert len(res["grid"]) == 6 and res["params"] in [g["params"] for g in res["grid"]]
    assert len(res["curves"]["strategy"]) > 50 and bt["oos_sharpe"] == res["out_of_sample"]["strategy"]["sharpe"]

    listing = (await client.get(f"{API}/backtests", headers=h)).json()
    assert listing["total"] == 1
    async with new_client() as other:
        oh = await auth_headers(other, email="o@example.com")
        assert (await other.get(f"{API}/backtests/{bt['id']}", headers=oh)).status_code == 404
    ah = await admin_headers(client)
    audit = (await client.get(f"{API}/admin/audit?action=backtest.run", headers=ah)).json()
    assert audit["total"] == 1 and audit["items"][0]["details"]["strategy"] == "sma_crossover"


async def test_fixed_params_and_validation(client):
    h = await auth_headers(client)
    r = await client.post(f"{API}/backtests", headers=h, json={
        "strategy": "donchian_breakout", "symbol": "EURUSD", "days": 90, "optimise": False, "params": {"lookback": 72}})
    assert r.status_code == 201 and r.json()["params"] == {"lookback": 72} and r.json()["result"]["grid"] == []
    for bad in ({"strategy": "nope", "symbol": "BTC-USD"},
                {"strategy": "sma_crossover", "symbol": "BTC-USD", "params": {"fast": 80, "slow": 50}},
                {"strategy": "sma_crossover", "symbol": "BTC-USD", "params": {"bogus": 1}},
                {"strategy": "sma_crossover", "symbol": "BTC-USD", "days": 5}):
        assert (await client.post(f"{API}/backtests", headers=h, json=bad)).status_code == 422, bad
    assert (await client.post(f"{API}/backtests", headers=h, json={"strategy": "sma_crossover", "symbol": "NOPE"})).status_code == 404
