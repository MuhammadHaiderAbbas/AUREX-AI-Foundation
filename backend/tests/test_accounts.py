import asyncio
from decimal import Decimal

from tests.conftest import API, auth_headers, new_client


async def _create(client, headers, **body):
    payload = {"name": "Main paper", **body}
    return await client.post(f"{API}/accounts", headers=headers, json=payload)


async def test_create_paper_account_with_default_balance(client):
    h = await auth_headers(client)
    r = await _create(client, h)
    assert r.status_code == 201, r.text
    acct = r.json()
    assert acct["mode"] == "PAPER" and acct["status"] == "ACTIVE"
    assert Decimal(acct["cash_balance"]) == Decimal("100000")
    assert Decimal(acct["equity"]) == Decimal("100000")

    bal = (await client.get(f"{API}/accounts/{acct['id']}/balances", headers=h)).json()
    assert bal["ledger_balanced"] is True
    lines = {ln["code"]: Decimal(ln["balance"]) for ln in bal["lines"]}
    assert lines["CASH"] == Decimal("100000")
    assert lines["OPENING_EQUITY"] == Decimal("100000")

    ledger = (await client.get(f"{API}/accounts/{acct['id']}/ledger", headers=h)).json()
    assert ledger["total"] == 1
    txn = ledger["items"][0]
    assert txn["type"] == "INITIAL_FUNDING"
    assert {(e["ledger_code"], e["direction"]) for e in txn["entries"]} == {
        ("CASH", "DEBIT"), ("OPENING_EQUITY", "CREDIT")}


async def test_create_validations(client):
    h = await auth_headers(client)
    assert (await _create(client, h, base_currency="JPY")).status_code == 422
    assert (await _create(client, h, starting_balance="10000000.01")).status_code == 422
    assert (await _create(client, h, starting_balance="-5")).status_code == 422
    assert (await _create(client, h, starting_balance="1.123456789")).status_code == 422
    assert (await _create(client, h, name="   ")).status_code == 422
    r = await _create(client, h, base_currency="gbp", starting_balance="2500.50")
    assert r.status_code == 201
    assert r.json()["base_currency"] == "GBP"
    assert Decimal(r.json()["cash_balance"]) == Decimal("2500.50")


async def test_live_mode_cannot_be_requested(client):
    h = await auth_headers(client)
    r = await _create(client, h, mode="LIVE")  # unknown field is ignored; always PAPER
    assert r.status_code == 201 and r.json()["mode"] == "PAPER"


async def test_accounts_are_private_to_owner(client):
    h1 = await auth_headers(client, email="a@example.com")
    acct = (await _create(client, h1)).json()
    async with new_client() as other:
        h2 = await auth_headers(other, email="b@example.com")
        assert (await other.get(f"{API}/accounts/{acct['id']}", headers=h2)).status_code == 404
        r = await other.post(f"{API}/accounts/{acct['id']}/withdrawals", headers=h2,
                             json={"amount": "1"})
        assert r.status_code == 404
        assert (await other.get(f"{API}/accounts", headers=h2)).json() == []


async def test_deposit_and_withdraw_with_exact_decimal_math(client):
    h = await auth_headers(client)
    acct = (await _create(client, h, starting_balance="0.1")).json()
    aid = acct["id"]
    r = await client.post(f"{API}/accounts/{aid}/deposits", headers=h,
                          json={"amount": "0.2", "description": "top up"})
    assert r.status_code == 201
    assert r.json()["type"] == "VIRTUAL_DEPOSIT"
    got = (await client.get(f"{API}/accounts/{aid}", headers=h)).json()
    assert Decimal(got["cash_balance"]) == Decimal("0.3")  # no float drift

    r = await client.post(f"{API}/accounts/{aid}/withdrawals", headers=h, json={"amount": "0.3"})
    assert r.status_code == 201
    bal = (await client.get(f"{API}/accounts/{aid}/balances", headers=h)).json()
    assert Decimal(bal["cash"]) == 0 and bal["ledger_balanced"] is True


async def test_withdrawal_cannot_overdraw(client):
    h = await auth_headers(client)
    aid = (await _create(client, h, starting_balance="100")).json()["id"]
    r = await client.post(f"{API}/accounts/{aid}/withdrawals", headers=h, json={"amount": "100.01"})
    assert r.status_code == 422
    assert r.json()["error"]["details"]["available"] == "100.00000000"


async def test_invalid_amounts(client):
    h = await auth_headers(client)
    aid = (await _create(client, h)).json()["id"]
    for amount in ["0", "-1", "NaN", "Infinity", "1e-9", "abc"]:
        r = await client.post(f"{API}/accounts/{aid}/deposits", headers=h,
                              json={"amount": amount})
        assert r.status_code == 422, amount


async def test_idempotent_deposit(client):
    h = await auth_headers(client)
    aid = (await _create(client, h)).json()["id"]
    hk = {**h, "Idempotency-Key": "deposit-0001-abcdef"}
    r1 = await client.post(f"{API}/accounts/{aid}/deposits", headers=hk, json={"amount": "500"})
    r2 = await client.post(f"{API}/accounts/{aid}/deposits", headers=hk, json={"amount": "500"})
    assert r1.status_code == 201 and r2.status_code == 200
    assert r2.headers["idempotent-replay"] == "true"
    assert r1.json()["id"] == r2.json()["id"]
    got = (await client.get(f"{API}/accounts/{aid}", headers=h)).json()
    assert Decimal(got["cash_balance"]) == Decimal("100500")

    r3 = await client.post(f"{API}/accounts/{aid}/deposits", headers=hk, json={"amount": "501"})
    assert r3.status_code == 409


async def test_concurrent_withdrawals_never_overdraw(client):
    h = await auth_headers(client)
    aid = (await _create(client, h, starting_balance="100000")).json()["id"]

    async def withdraw():
        async with new_client() as c:
            return await c.post(f"{API}/accounts/{aid}/withdrawals", headers=h,
                                json={"amount": "30000"})

    results = await asyncio.gather(*[withdraw() for _ in range(6)])
    codes = sorted(r.status_code for r in results)
    assert codes.count(201) == 3 and codes.count(422) == 3, codes
    bal = (await client.get(f"{API}/accounts/{aid}/balances", headers=h)).json()
    assert Decimal(bal["cash"]) == Decimal("10000")
    assert bal["ledger_balanced"] is True


async def test_ledger_pagination(client):
    h = await auth_headers(client)
    aid = (await _create(client, h)).json()["id"]
    for i in range(4):
        await client.post(f"{API}/accounts/{aid}/deposits", headers=h, json={"amount": str(i + 1)})
    page = (await client.get(f"{API}/accounts/{aid}/ledger?limit=2&offset=0", headers=h)).json()
    assert page["total"] == 5 and len(page["items"]) == 2


async def test_account_limit(client):
    h = await auth_headers(client)
    for i in range(10):
        assert (await _create(client, h, name=f"acct {i}")).status_code == 201
    assert (await _create(client, h, name="one too many")).status_code == 422
