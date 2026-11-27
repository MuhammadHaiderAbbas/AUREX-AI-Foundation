"""The "explain it to me" coach: grounded builtin answers, Claude engine with fallback, privacy."""

from types import SimpleNamespace

import anthropic
import httpx

from app import coach
from app.research import llm as research_llm
from tests.conftest import API, admin_headers
from tests.test_binary import expire_all, open_, small_account
from tests.test_security import settings_env
from tests.test_trading import fake_quotes, set_price  # noqa: F401  (autouse fixture)


async def _ask(client, h, q, **extra):
    r = await client.post(f"{API}/coach/ask", headers=h, json={"question": q, **extra})
    assert r.status_code == 200, r.text
    return r.json()


async def test_builtin_coach_explains_the_bot_record_from_real_data(client):
    h, aid = await small_account(client)
    set_price("BTC-USD", "50000", spread="0")
    for _ in range(3):                                      # the risk gate allows three open contracts
        assert (await open_(client, h, aid, direction="HIGHER", stake="1.00")).status_code == 201
    await expire_all()
    set_price("BTC-USD", "49000", spread="0")
    await client.get(f"{API}/binary/contracts?account_id={aid}", headers=h)        # settle: all lost
    a = await _ask(client, h, "Why is my bot losing?")
    assert a["engine"] == "builtin"
    assert "0 won and 3 lost" in a["answer"] and "55.6%" in a["answer"] and "far too few" in a["answer"]
    assert a["suggestions"]
    d = await _ask(client, h, "What is break-even win rate?")
    assert d["facts"] == ["Definition"] and "1 / 1.8" in d["answer"]
    p = await _ask(client, h, "How am I doing?")
    assert "is worth" in p["answer"]


async def test_coach_without_an_account_and_admins(client):
    from tests.conftest import auth_headers
    h = await auth_headers(client, email="empty@example.com")
    assert "don't have a paper account" in (await _ask(client, h, "How am I doing?"))["answer"]
    assert (await client.post(f"{API}/coach/ask", headers=await admin_headers(client), json={"question": "hi there"})).status_code == 403
    assert (await client.post(f"{API}/coach/ask", headers=h, json={"question": "x"})).status_code == 422


class FakeClaude:
    def __init__(self, text="", stop_reason="end_turn", exc=None):
        self.text, self.stop_reason, self.exc, self.calls = text, stop_reason, exc, []
        self.beta = SimpleNamespace(messages=SimpleNamespace(create=self._create))

    async def _create(self, **kwargs):
        self.calls.append(kwargs)
        if self.exc:
            raise self.exc
        return SimpleNamespace(stop_reason=self.stop_reason, model=kwargs["model"],
                               content=[SimpleNamespace(type="thinking", thinking=""), SimpleNamespace(type="text", text=self.text)])


async def test_claude_engine_uses_account_facts_and_falls_back(client, monkeypatch):
    h, aid = await small_account(client, email="claude@example.com")
    settings_env(monkeypatch, coach_engine="claude")
    fake = FakeClaude("You have £100 in cash and no trades yet.")
    research_llm.set_client(fake)
    try:
        a = await _ask(client, h, "How am I doing?", history=[{"role": "user", "content": "hello"}, {"role": "assistant", "content": "Hi!"}])
        assert a["engine"] == "claude:claude-opus-5-5" and a["answer"].startswith("You have £100")
        call = fake.calls[0]
        assert call["system"] == coach.SYSTEM and call["output_config"]["effort"] == "low"
        assert call["messages"][0]["content"] == "hello" and "<account_facts>" in call["messages"][-1]["content"]
        assert '"currency": "GBP"' in call["messages"][-1]["content"]
        research_llm.set_client(FakeClaude(stop_reason="refusal"))
        assert (await _ask(client, h, "How am I doing?"))["engine"].startswith("builtin (")
        req = httpx.Request("POST", "https://api.anthropic.com/v1/messages")
        research_llm.set_client(FakeClaude(exc=anthropic.APIConnectionError(request=req)))
        fb = await _ask(client, h, "How am I doing?")
        assert fb["engine"] == "builtin (Claude is unavailable right now)" and "is worth" in fb["answer"]
    finally:
        research_llm.set_client(None)


def test_wilson_matches_the_bot():
    from app.binary.bot import wilson_bounds
    assert coach.wilson(3, 10) == wilson_bounds(3, 10)
