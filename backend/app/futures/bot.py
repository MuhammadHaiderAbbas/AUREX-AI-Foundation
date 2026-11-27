"""The automatic futures bot: one button, trades only with a validated edge, always with exits.

Every cycle (15 minutes by default) it asks the AI futures model (app.futures.signal) about each of
its markets. When the model has a validated edge after costs it opens a position through the normal
FuturesService path, so every risk check applies:
  - side from the model; leverage = the model's volatility-based suggestion, capped by the bot's maximum;
  - margin = margin_pct of equity (at least the 1.00 minimum);
  - a stop-loss at the model's 2x ATR stop distance and a time exit after the model's 4-hour horizon.
Exits are checked on every worker pass (not just every cycle), and liquidation still applies underneath.

It pauses itself when:
  - the account's risk engine blocks trading (halt, kill switch, daily-loss or drawdown breaker);
  - after 8 closed trades, even the optimistic end of a 95% range for its average return on margin is below zero;
  - after 20 closed trades, its average return is negative.
"""

import math
import time
import uuid
from datetime import UTC, datetime, timedelta
from decimal import ROUND_DOWN, Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.errors import AppError
from app.futures.service import MIN_MARGIN, FuturesService, OpenRequest
from app.futures.signal import HORIZON, futures_signal
from app.market.service import MarketService
from app.models import FuturesBot, FuturesPosition, FuturesStatus, RiskEvent, TradingAccount, User
from app.risk.service import RiskService

DEFAULT_SYMBOLS = ["BTC-USD", "ETH-USD"]
EARLY_GUARD = 8
LATE_GUARD = 20
SIGNAL_TTL = 600          # seconds a model run is reused (it trains on hourly bars)
CENT = Decimal("0.01")
_signals: dict[str, tuple[float, dict[str, Any]]] = {}


def interval() -> int:
    return get_settings().futures_bot_interval_seconds


async def signal_for(db: AsyncSession, symbol: str) -> dict[str, Any]:
    hit = _signals.get(symbol)
    if hit and time.monotonic() - hit[0] < SIGNAL_TTL:
        return hit[1]
    sig = await futures_signal(MarketService(db), symbol)
    _signals[symbol] = (time.monotonic(), sig)
    return sig


PRACTICE_MAX_MARGIN_PCT = 2.0
PRACTICE_MAX_LEVERAGE = 2


async def scan_symbols(db: AsyncSession) -> list[str]:
    from app.binary.bot import scan_symbols as crypto_markets
    return await crypto_markets(db)


def practice_call(sig: dict[str, Any]) -> dict[str, Any]:
    """Practice (high risk): trade the model's current direction at its usual 55% confidence, with no proven edge."""
    from app.futures.signal import CONFIDENCE
    if sig["trade"] or sig.get("direction") is None or sig.get("confidence") is None:
        return sig
    if sig["confidence"] < CONFIDENCE:
        return {**sig, "reason": f"practice mode: model only {sig['confidence']:.0%} sure (needs {CONFIDENCE:.0%})"}
    mean = sig.get("mean_return")
    tested = f"tested {mean * 100:+.2f}% per trade after costs" if mean is not None else "not tested yet"
    return {**sig, "trade": True, "reason": f"practice mode, NO proven edge: model {sig['confidence']:.0%} sure {sig['direction']}; {tested}"}


def clear_cache() -> None:
    _signals.clear()


async def get_bot(db: AsyncSession, account_id, lock: bool = False) -> FuturesBot:
    stmt = select(FuturesBot).where(FuturesBot.account_id == account_id)
    if lock:
        stmt = stmt.with_for_update()
    bot = await db.scalar(stmt)
    if bot is None:
        bot = FuturesBot(account_id=account_id, status="STOPPED", symbols=list(DEFAULT_SYMBOLS), margin_pct=5.0, max_leverage=3)
        db.add(bot)
        await db.flush()
    return bot


def pause(risk: RiskService, bot: FuturesBot, reason: str) -> None:
    if bot.status == "RUNNING":
        bot.status, bot.paused_reason = "PAUSED", reason
        risk.event(bot.account_id, "FUTURES_BOT_PAUSED", f"Futures bot paused: {reason}")


async def bot_stats(db: AsyncSession, bot: FuturesBot) -> dict[str, Any]:
    """Bot positions since it was last started (the guard's window). Returns are realised P&L / margin."""
    stmt = select(FuturesPosition).where(FuturesPosition.account_id == bot.account_id, FuturesPosition.source == "bot")
    if bot.started_at:
        stmt = stmt.where(FuturesPosition.opened_at >= bot.started_at)
    rows = list(await db.scalars(stmt))
    closed = [p for p in rows if p.status != FuturesStatus.OPEN]
    rets = [float((p.realised_pnl or 0) / p.margin) if p.margin else -1.0 for p in closed]
    n = len(rets)
    mean = sum(rets) / n if n else None
    sd = math.sqrt(sum((r - mean) ** 2 for r in rets) / (n - 1)) if n > 1 else 0.0
    return {"trades": len(rows), "open": len(rows) - n, "closed": n, "wins": sum(r > 0 for r in rets), "losses": sum(r <= 0 for r in rets),
            "liquidated": sum(p.status == FuturesStatus.LIQUIDATED for p in closed),
            "stopped": sum(p.exit_reason == "stop" for p in closed), "timed_out": sum(p.exit_reason == "time" for p in closed),
            "net_pnl": sum((p.realised_pnl or Decimal(0) for p in closed), Decimal(0)),
            "fees": sum((p.fees for p in rows), Decimal(0)),
            "avg_return_on_margin": mean, "return_upper": (mean + 1.96 * sd / math.sqrt(n)) if n > 1 else None}


async def manage_exits(db: AsyncSession) -> int:
    """Worker, every pass: close bot positions whose stop-loss was hit or whose 4-hour horizon is over."""
    svc = FuturesService(db)
    now = datetime.now(UTC)
    n = 0
    for pos in list(await db.scalars(select(FuturesPosition).where(FuturesPosition.status == FuturesStatus.OPEN,
                                                                   FuturesPosition.source == "bot").with_for_update(skip_locked=True))):
        reason = None
        if pos.exit_due_at and now >= pos.exit_due_at:
            reason = "time"
        elif pos.stop_price is not None:
            m = await svc.mark(await svc.instrument(pos.symbol))
            if m is not None and ((pos.side == "LONG" and m <= pos.stop_price) or (pos.side == "SHORT" and m >= pos.stop_price)):
                reason = "stop"
        if reason is None:
            continue
        try:
            await svc.close_position(pos, None, reason)
        except AppError:
            continue                                   # thin book right now: try again on the next pass
        RiskService(db).event(pos.account_id, "FUTURES_BOT_EXIT",
                              f"Futures bot closed {pos.side} {pos.symbol} ({'stop-loss' if reason == 'stop' else 'time exit'}): "
                              f"P&L {pos.realised_pnl:+.2f}", position_id=str(pos.id), reason=reason)
        n += 1
    await db.flush()
    return n


async def run_bot_cycle(db: AsyncSession, acct: TradingAccount, bot: FuturesBot) -> dict[str, Any]:
    risk = RiskService(db)
    now = datetime.now(UTC)
    out: dict[str, Any] = {"at": now.isoformat(), "results": []}
    bot.last_cycle_at = now
    prof = await risk.profile(acct.id)
    block = await risk.block_reason(prof)
    if block:
        pause(risk, bot, block)
        out["skipped"] = block
        await db.flush()
        return out
    st = await bot_stats(db, bot)
    if st["closed"] >= EARLY_GUARD and st["return_upper"] is not None and st["return_upper"] < 0:
        reason = (f"edge guard: {st['closed']} closed trades averaged {st['avg_return_on_margin']:+.1%} on margin; even the "
                  f"optimistic end of the 95% range ({st['return_upper']:+.1%}) is below zero")
    elif st["closed"] >= LATE_GUARD and st["avg_return_on_margin"] < 0:
        reason = f"edge guard: {st['closed']} closed trades averaged {st['avg_return_on_margin']:+.1%} on margin"
    else:
        reason = None
    if reason:
        pause(risk, bot, reason)
        out["skipped"] = reason
        await db.flush()
        return out

    user = await db.get(User, acct.owner_id)
    svc = FuturesService(db)
    practice = bot.risk_mode == "practice"
    symbols = await scan_symbols(db) if bot.scan else bot.symbols
    for symbol in symbols:
        open_here = await db.scalar(select(FuturesPosition.id).where(
            FuturesPosition.account_id == acct.id, FuturesPosition.source == "bot", FuturesPosition.symbol == symbol,
            FuturesPosition.status == FuturesStatus.OPEN).limit(1))
        if open_here:
            out["results"].append({"symbol": symbol, "outcome": "holding", "detail": "the bot already holds a position here; it exits on its stop or after 4 hours"})
            continue
        try:
            sig = await signal_for(db, symbol)
        except AppError as e:
            out["results"].append({"symbol": symbol, "outcome": "error", "detail": e.message})
            continue
        brief = {k: sig.get(k) for k in ("direction", "p_up", "confidence", "trades", "hit_rate", "mean_return", "return_lower", "folds",
                                         "folds_profitable", "suggested_leverage", "stop_distance_pct")}
        if practice:
            sig = practice_call(sig)
        brief["mode"] = bot.risk_mode
        if not sig["trade"]:
            out["results"].append({"symbol": symbol, "outcome": "no_trade", "detail": sig["reason"], "signal": brief})
            continue
        summary = await svc.trading.summary(acct, take_snapshot=False)
        margin_pct = min(bot.margin_pct, PRACTICE_MAX_MARGIN_PCT) if practice else bot.margin_pct
        margin = max((summary["equity"] * Decimal(str(margin_pct)) / 100).quantize(CENT, rounding=ROUND_DOWN), MIN_MARGIN)
        lev = max(1, min(int(sig["suggested_leverage"] or 1), bot.max_leverage, PRACTICE_MAX_LEVERAGE if practice else bot.max_leverage))
        try:
            pos, _ = await svc.open(user, OpenRequest(acct.id, symbol, sig["direction"], margin, lev, f"bot-{uuid.uuid4().hex}", source="bot"))
        except AppError as e:
            out["results"].append({"symbol": symbol, "outcome": "risk_rejected", "detail": e.message, "signal": brief})
            continue
        stop = Decimal(str(sig["stop_distance_pct"])) / 100
        pos.stop_price = pos.entry_price * (1 - stop if pos.side == "LONG" else 1 + stop)
        pos.exit_due_at = now + timedelta(hours=HORIZON)
        pos.signal = {**brief, "reason": sig["reason"]}
        out["results"].append({"symbol": symbol, "outcome": "opened", "position_id": str(pos.id), "side": pos.side, "leverage": lev,
                               "margin": str(margin), "stop_price": str(pos.stop_price.quantize(CENT)), "detail": sig["reason"], "signal": brief})
    n = sum(r["outcome"] == "opened" for r in out["results"])
    risk.event(acct.id, "FUTURES_BOT_CYCLE", f"Futures bot: {len(out['results'])} markets checked, {n} positions opened", results=out["results"])
    await db.flush()
    return out


async def due_bots(db: AsyncSession) -> list[tuple[TradingAccount, FuturesBot]]:
    now = datetime.now(UTC)
    out = []
    for bot in await db.scalars(select(FuturesBot).where(FuturesBot.status == "RUNNING").with_for_update(skip_locked=True)):
        if bot.last_cycle_at is None or (now - bot.last_cycle_at).total_seconds() >= interval():
            out.append((await db.get(TradingAccount, bot.account_id), bot))
    return out


async def recent_cycles(db: AsyncSession, account_id, limit: int = 15) -> list[dict[str, Any]]:
    rows = await db.scalars(select(RiskEvent).where(RiskEvent.account_id == account_id, RiskEvent.type.in_(
        ["FUTURES_BOT_CYCLE", "FUTURES_BOT_PAUSED", "FUTURES_BOT_CONTROL", "FUTURES_BOT_EXIT"])).order_by(RiskEvent.created_at.desc()).limit(limit))
    return [{"at": e.created_at, "type": e.type, "message": e.message, "results": e.detail.get("results", [])} for e in rows]
