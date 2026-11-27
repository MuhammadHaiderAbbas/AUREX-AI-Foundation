"""The "explain it to me" coach.

It answers a trader's question in plain English, using only facts about their own account:
- the paper account's equity, cash, P&L and drawdown;
- recent binary contracts, the bot's record and why it paused;
- the latest AI desk decision and the agents' reasoning;
- recently closed trades;
- their price alerts.

Two engines:
- builtin (default, offline): deterministic explanations from templates; the public demo has the
  same engine in the browser.
- claude: Claude writes the answer from the same facts. It needs an Anthropic API key on the
  server and AUREX_COACH_ENGINE=claude. On any API error it falls back to the builtin engine.

The coach never gives financial advice or promises returns, and says when the data cannot answer.
"""

import json
import logging
import math
from dataclasses import dataclass, field
from typing import Any

import anthropic
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.models import AIRun, BinaryContract, BinaryStatus, Position, PriceAlert, TradingAccount, User

log = logging.getLogger("aurex.coach")
PAYOUT_FALLBACK = 0.8


@dataclass
class Answer:
    answer: str
    facts: list[str] = field(default_factory=list)
    engine: str = "builtin"
    suggestions: list[str] = field(default_factory=list)


def wilson(hits: int, n: int, z: float = 1.96) -> tuple[float, float]:
    if n == 0:
        return 0.0, 1.0
    p = hits / n
    c = (p + z * z / (2 * n)) / (1 + z * z / n)
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / (1 + z * z / n)
    return max(0.0, c - h), min(1.0, c + h)


def _f(v: Any) -> float:
    return float(v) if v is not None else 0.0


async def gather(db: AsyncSession, user: User, account_id=None) -> dict[str, Any]:
    """Facts about this trader's account, as plain data (also what Claude sees)."""
    from app.binary.bot import get_bot
    from app.binary.service import config as binary_config
    from app.trading.service import TradingService

    accts = list(await db.scalars(select(TradingAccount).where(TradingAccount.owner_id == user.id,
                                                               TradingAccount.status == "ACTIVE")
                                  .order_by(TradingAccount.created_at)))
    acct = next((a for a in accts if str(a.id) == str(account_id)), accts[0] if accts else None)
    ctx: dict[str, Any] = {"trader": user.full_name, "accounts": len(accts), "account": None, "binary": None,
                           "last_ai_run": None, "closed_trades": [], "alerts": {}}
    if acct is None:
        return ctx
    summ = await TradingService(db).summary(acct, take_snapshot=False)
    ctx["account"] = {"name": acct.name, "currency": acct.base_currency, "equity": _f(summ["equity"]), "cash": _f(summ["cash"]),
                      "unrealised_pnl": _f(summ["unrealised_pnl"]), "realised_pnl": _f(summ["realised_pnl"]),
                      "fees": _f(summ["fees"]), "open_positions": summ["open_positions"]}

    contracts = list(await db.scalars(select(BinaryContract).where(BinaryContract.account_id == acct.id)
                                      .order_by(BinaryContract.created_at.desc()).limit(20)))
    if contracts:
        settled = [c for c in contracts if c.status in (BinaryStatus.WON, BinaryStatus.LOST)]
        won = sum(c.status == BinaryStatus.WON for c in settled)
        lo, hi = wilson(won, len(settled))
        payout = float(binary_config().get("payout_rate", PAYOUT_FALLBACK))
        bot = await get_bot(db, acct.id)
        ctx["binary"] = {
            "payout_rate": payout, "break_even": 1 / (1 + payout),
            "recent": [{"direction": c.direction, "symbol": c.symbol, "expiry_seconds": c.expiry_seconds, "stake": _f(c.stake),
                        "strike": _f(c.strike), "settle": _f(c.settle_price), "status": c.status, "pnl": _f(c.pnl), "source": c.source}
                       for c in contracts[:10]],
            "won": won, "lost": len(settled) - won, "net_pnl": sum(_f(c.pnl) for c in settled),
            "win_rate": won / len(settled) if settled else None, "win_rate_95": [lo, hi],
            "bot_status": bot.status, "bot_paused_reason": bot.paused_reason, "bot_expiry_seconds": bot.expiry_seconds,
        }

    run = await db.scalar(select(AIRun).where(AIRun.user_id == user.id).order_by(AIRun.created_at.desc()).limit(1))
    if run:
        findings = sorted(run.findings, key=lambda f: -abs(f.score))
        ctx["last_ai_run"] = {"symbol": run.symbol, "decision": run.decision, "bias": run.bias, "net_score": run.net_score,
                              "agreement": run.agreement, "confidence": run.confidence, "reasons": run.reasons[:5],
                              "agents": [{"agent": f.agent, "status": f.status, "direction": f.direction, "score": round(f.score, 3),
                                          "summary": f.summary[:300]} for f in findings[:6]]}

    closed = list(await db.scalars(select(Position).where(Position.account_id == acct.id, Position.status == "CLOSED")
                                   .order_by(Position.closed_at.desc()).limit(5)))
    ctx["closed_trades"] = [{"symbol": p.symbol, "realised_pnl": _f(p.realised_pnl), "fees": _f(p.fees)} for p in closed]
    alerts = list(await db.scalars(select(PriceAlert).where(PriceAlert.user_id == user.id)))
    ctx["alerts"] = {"active": sum(a.status == "ACTIVE" for a in alerts), "triggered": sum(a.status == "TRIGGERED" for a in alerts)}
    return ctx


# ---- builtin engine -------------------------------------------------------------------------
GLOSSARY: dict[str, str] = {
    "break-even": "Break-even win rate is how often you must be right just to not lose money. A binary contract pays 80% of the stake if right and loses the whole stake if wrong, so you need to win 1 / 1.8 = 55.6% of the time. Below that, you lose on average.",
    "drawdown": "Drawdown is how far your account is below its highest value so far, in percent. A 10% drawdown means you are 10% below your best. The risk engine stops trading if it gets too deep.",
    "stop": "A stop-loss is an order that sells automatically if the price falls to a level you choose, to cap how much one trade can lose.",
    "leverage": "Leverage lets you control a bigger position than your cash. With 5x, £10 of margin controls £50 of crypto, so a 1% move changes your margin by 5%, in either direction.",
    "liquidation": "Liquidation is when a leveraged position has lost almost all its margin, so it is closed automatically. The liquidation price is shown before you trade, and it is closer to your entry the higher the leverage.",
    "funding": "Funding is a small fee paid between long and short traders on perpetual futures every 8 hours, to keep the futures price close to the real price.",
    "spread": "The spread is the gap between the buy (ask) and sell (bid) price. You pay it every time you trade.",
    "slippage": "Slippage is the difference between the price you expected and the price you got, usually because the order was bigger than the best price had room for.",
    "rsi": "RSI (relative strength index) is a 0-100 gauge of recent momentum. Above 70 is often called overbought, below 30 oversold. It is a hint, not a signal on its own.",
    "sma": "A simple moving average (SMA) is the average price over the last N candles. Price above a rising SMA suggests an up-trend.",
    "paper": "Paper trading means trading with virtual money on real prices. Nothing you do on AUREX can lose real money.",
}
SUGGESTIONS = ["Why is my bot losing?", "Why did the AI say no trade?", "How am I doing?", "What is break-even win rate?",
               "Explain my last trade", "What is leverage?"]


def _money(v: float, ccy: str) -> str:
    sym = {"GBP": "£", "USD": "$", "EUR": "€"}.get(ccy, "")
    return f"{'-' if v < 0 else ''}{sym}{abs(v):,.2f}" + ("" if sym else f" {ccy}")


def builtin(question: str, ctx: dict[str, Any]) -> Answer:
    q = question.lower()
    acct, binary, run = ctx.get("account"), ctx.get("binary"), ctx.get("last_ai_run")
    ccy = acct["currency"] if acct else "GBP"
    for key, text in GLOSSARY.items():
        if key in q or (key == "break-even" and "breakeven" in q) or (key == "stop" and "stop-loss" in q):
            if not any(w in q for w in ("my ", "bot", "why")):
                return Answer(text, ["Definition"], suggestions=SUGGESTIONS)

    if any(w in q for w in ("bot", "binary", "losing", "lose", "lost", "win rate")) and binary:
        b = binary
        n = b["won"] + b["lost"]
        lo, hi = b["win_rate_95"]
        parts = []
        if n:
            parts.append(f"Your recent binary record is {b['won']} won and {b['lost']} lost ({b['win_rate']:.0%}), net {_money(b['net_pnl'], ccy)}. "
                         f"To break even you need to win {b['break_even']:.1%} of the time, because a win pays {b['payout_rate']:.0%} of the stake but a loss costs all of it.")
            if n < 30:
                parts.append(f"{n} contracts is far too few to judge. With that record the true win rate could be anywhere from {lo:.0%} to {hi:.0%} "
                             "(95% range), so this could be bad luck or a real lack of edge. It takes dozens of contracts to tell.")
            elif hi < b["break_even"]:
                parts.append("Over this many contracts the record is clearly below break-even: the bot has no edge here.")
        parts.append(f"Short expiries ({b['bot_expiry_seconds']} seconds for your bot) are mostly random noise, so even a good model wins only slightly more than half the time. "
                     "The bot only trades when its out-of-sample tests show a proven edge, and it pauses itself when its live record shows it has none.")
        if b["bot_status"] == "PAUSED" and b["bot_paused_reason"]:
            parts.append(f"Right now it is paused: {b['bot_paused_reason']}.")
        return Answer("\n\n".join(parts), [f"{n} settled binary contracts", f"break-even {b['break_even']:.1%}", f"bot {b['bot_status'].lower()}"],
                      suggestions=SUGGESTIONS)

    if any(w in q for w in ("no trade", "ai", "agent", "desk", "decision", "why did")) and run:
        r = run
        decision = "no trade" if r["decision"] != "BUY" else "buy"
        parts = [f"The last AI desk run on {r['symbol']} decided {decision.upper()} (net score {r['net_score']:+.2f}, agents agreeing {r['agreement']:.0%})."]
        if r["reasons"]:
            parts.append("The main reasons were: " + "; ".join(r["reasons"][:3]) + ".")
        strongest = [a for a in r["agents"] if a["status"] == "ok"][:3]
        if strongest:
            parts.append("The agents with the strongest views: " + "; ".join(
                f"{a['agent']} ({'up' if a['direction'] > 0 else 'down' if a['direction'] < 0 else 'neutral'}, {a['score']:+.2f}): {a['summary'][:140]}" for a in strongest) + ".")
        parts.append("The desk only proposes a trade when the evidence is strong and consistent and every safety check passes. "
                     "'No trade' is often the honest answer in a quiet or mixed market.")
        return Answer("\n\n".join(parts), [f"AI run on {r['symbol']}", f"decision {r['decision']}"], suggestions=SUGGESTIONS)

    if any(w in q for w in ("last trade", "my trade", "closed")) and ctx.get("closed_trades"):
        t = ctx["closed_trades"][0]
        res = "made" if t["realised_pnl"] > 0 else "lost"
        return Answer(f"Your last closed trade was {t['symbol']}: you {res} {_money(abs(t['realised_pnl']), ccy)} after {_money(t['fees'], ccy)} of fees. "
                      "Small trades are hit hardest by fees and spread, so very short trades need a bigger move to come out ahead.",
                      [f"last closed position {t['symbol']}"], suggestions=SUGGESTIONS)

    if acct and any(w in q for w in ("how am i", "doing", "performance", "profit", "equity", "balance", "account")):
        a = acct
        pnl = a["unrealised_pnl"] + a["realised_pnl"]
        return Answer(f"{a['name']} is worth {_money(a['equity'], ccy)}, with {_money(a['cash'], ccy)} in cash and {a['open_positions']} open position(s). "
                      f"Total profit and loss so far is {_money(pnl, ccy)} (fees paid {_money(a['fees'], ccy)}). "
                      "For a fuller picture, Analytics shows your return, drawdown and how you compare with simply holding the market.",
                      [f"account {a['name']}"], suggestions=SUGGESTIONS)

    if acct is None:
        return Answer("You don't have a paper account yet. Create one from the Dashboard (start with £100), then I can explain your trades and results.",
                      [], suggestions=SUGGESTIONS)
    return Answer("I can explain your bot's results, why the AI desk did or didn't trade, your last trade, how your account is doing, "
                  "and trading terms such as break-even, drawdown, spread, leverage or liquidation. Try one of the suggestions below.",
                  [], suggestions=SUGGESTIONS)


# ---- Claude engine ----------------------------------------------------------------------------
SYSTEM = """You are the AUREX coach, inside a paper-trading platform (virtual money on real prices).
Explain things to a beginner in plain, friendly English: short paragraphs, no jargon without a one-line explanation.
Use ONLY the facts in <account_facts>. If they cannot answer the question, say so and say what data would.
Be honest about uncertainty: a handful of trades proves nothing either way, and short expiries are mostly noise.
Never give personal financial advice, never tell the trader to buy or sell a specific asset with real money, and never promise returns.
Keep answers under 180 words unless the trader asks for detail."""


async def claude_answer(question: str, ctx: dict[str, Any], history: list[dict[str, str]]) -> Answer:
    from app.research.llm import _FALLBACK_MODELS, _get_client
    s = get_settings()
    messages: list[dict[str, Any]] = [{"role": h["role"], "content": h["content"]} for h in history[-6:]]
    messages.append({"role": "user", "content": f"<account_facts>\n{json.dumps(ctx, default=str)}\n</account_facts>\n\n{question}"})
    kwargs: dict[str, Any] = {"model": s.llm_model, "max_tokens": 4000, "thinking": {"type": "adaptive"},
                              "output_config": {"effort": "low"}, "system": SYSTEM, "messages": messages}
    if s.llm_model in _FALLBACK_MODELS:
        kwargs["betas"] = ["server-side-fallback-2026-07-01"]
        kwargs["fallbacks"] = "default"
    try:
        response = await _get_client().beta.messages.create(**kwargs)
    except (anthropic.APIStatusError, anthropic.APIConnectionError) as e:
        log.warning("coach: Claude unavailable (%s); using the builtin engine", e.__class__.__name__)
        return _fallback(question, ctx, "Claude is unavailable right now")
    except TypeError as e:          # the SDK raises TypeError when no credentials resolve
        if "authentication" not in str(e).lower():
            raise
        return _fallback(question, ctx, "no API key is configured")
    if response.stop_reason in ("refusal", "max_tokens"):
        return _fallback(question, ctx, "the model could not answer this one")
    text = "\n\n".join(b.text for b in response.content if getattr(b, "type", "") == "text").strip()
    if not text:
        return _fallback(question, ctx, "empty response")
    return Answer(text, ["Your account data"], engine=f"claude:{getattr(response, 'model', s.llm_model)}", suggestions=SUGGESTIONS)


def _fallback(question: str, ctx: dict[str, Any], why: str) -> Answer:
    a = builtin(question, ctx)
    a.engine = f"builtin ({why})"
    return a


async def ask(db: AsyncSession, user: User, question: str, account_id=None, history: list[dict[str, str]] | None = None) -> Answer:
    ctx = await gather(db, user, account_id)
    if get_settings().coach_engine == "claude":
        return await claude_answer(question, ctx, history or [])
    return builtin(question, ctx)

