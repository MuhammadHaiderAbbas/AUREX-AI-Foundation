"""The one-button binary bot (paper only).

Every cycle, for each configured instrument, it:
  1. trains a small logistic model on recent bars whose length matches the contract expiry
     (leak-free features from app.ml.features; the target is "price higher after the expiry");
  2. tests it on the most recent 30% of bars it did not train on (with a purge gap), counting
     only the predictions confident enough that the bot would actually have traded them;
  3. opens a contract only if that out-of-sample hit rate beats the break-even rate
     (1 / (1 + payout), 55.6% at 80%) by a margin, AND today's prediction is that confident.
The contract then faces the same binary risk gate as a manual one (stake cap, open-contract cap,
breakers, kill switches, order rate).

The edge guard pauses the bot once it has settled enough contracts and its live win rate is
below break-even. Breakers, kill switches and platform halts pause it too.

None of this makes profit likely. With a payout below even money, most signals on real prices
will not pass step 3; on the synthetic demo feed (built from smooth cycles) they often do, which
says nothing about real markets. The UI says so next to the start button.
"""

import uuid
from datetime import UTC, datetime
from decimal import ROUND_DOWN, Decimal
from typing import Any

import numpy as np
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.binary.service import BinaryRequest, BinaryService, config
from app.core.config import get_settings
from app.core.errors import AppError
from app.market.service import MarketService
from app.ml.features import WARMUP, build_dataset, latest_features
from app.models import BinaryBot, BinaryContract, BinaryStatus, RiskEvent, TradingAccount, User
from app.risk.service import RiskService

# expiry seconds -> (bar timeframe, bars ahead)
EXPIRY_BARS = {60: ("1m", 1), 300: ("5m", 1), 900: ("15m", 1), 3600: ("1h", 1), 86400: ("1h", 24)}
DEFAULT_SYMBOLS = ["BTC-USD", "ETH-USD"]          # real Coinbase prices, 1-minute contracts by default
HISTORY_BARS = 1000
MIN_HOLDOUT = 30          # confident out-of-sample predictions needed before trusting the hit rate
CENT = Decimal("0.01")


def compute_signal(times: list[datetime], high: list[float], low: list[float], close: list[float], horizon: int, *,
                   payout: float, min_confidence: float, edge_margin: float) -> dict[str, Any]:
    """Pure: fit, validate out of sample, predict the next contract. No I/O."""
    from sklearn.linear_model import LogisticRegression
    from sklearn.pipeline import make_pipeline
    from sklearn.preprocessing import StandardScaler

    break_even = 1 / (1 + payout)
    threshold = max(min_confidence, break_even)
    required = break_even + edge_margin
    out: dict[str, Any] = {"break_even": break_even, "required_accuracy": required, "confidence_threshold": threshold,
                           "trade": False, "direction": None, "p_up": None, "confidence": None,
                           "holdout_accuracy": None, "holdout_n": 0, "train_n": 0, "expected_return": None}
    if len(close) <= WARMUP + horizon:
        return {**out, "reason": f"not enough history: 0 usable bars (need 200; have {len(close)} bars)"}
    ds = build_dataset(times, high, low, close, horizon)
    n = len(ds.y)
    if n < 200:
        return {**out, "reason": f"not enough history: {n} usable bars (need 200)"}
    split = int(n * 0.7)
    tr_end = split - horizon                                    # purge: no training label overlaps the test window
    if len(set(ds.y[:tr_end])) < 2:
        return {**out, "reason": "price only moved one way in the training window"}
    model = make_pipeline(StandardScaler(), LogisticRegression(C=0.5, max_iter=500))
    model.fit(ds.X[:tr_end], ds.y[:tr_end])
    p_test = model.predict_proba(ds.X[split:])[:, 1]
    conf_test = np.maximum(p_test, 1 - p_test)
    sel = conf_test >= threshold
    hits = ((p_test >= 0.5).astype(int) == ds.y[split:])[sel]
    acc = float(hits.mean()) if len(hits) else None
    out.update(holdout_n=int(sel.sum()), holdout_accuracy=acc, train_n=int(tr_end))

    model.fit(ds.X, ds.y)                                       # refit on everything for today's call
    row = latest_features(times, high, low, close)
    if row is None:
        return {**out, "reason": "latest bar has incomplete features"}
    p = float(model.predict_proba(row.reshape(1, -1))[0, 1])
    conf = max(p, 1 - p)
    out.update(p_up=p, confidence=conf, direction="HIGHER" if p >= 0.5 else "LOWER",
               expected_return=(acc * payout - (1 - acc)) if acc is not None else None)
    if out["holdout_n"] < MIN_HOLDOUT:
        out["reason"] = f"too few confident out-of-sample predictions to judge ({out['holdout_n']} < {MIN_HOLDOUT})"
    elif acc < required:
        out["reason"] = f"no validated edge: out-of-sample hit rate {acc:.1%} < {required:.1%} needed"
    elif conf < threshold:
        out["reason"] = f"not confident enough now: {conf:.1%} < {threshold:.1%}"
    else:
        out["trade"] = True
        out["reason"] = (f"edge validated: {acc:.1%} out-of-sample hit rate on {out['holdout_n']} confident calls; "
                         f"now {conf:.1%} {out['direction']}")
    return out


def cycle_interval(bot: BinaryBot) -> float:
    """Short contracts need frequent cycles or the bot sits idle between them."""
    return min(get_settings().binary_bot_interval_seconds, max(10.0, bot.expiry_seconds / 3))


async def signal_for(db: AsyncSession, symbol: str, expiry_seconds: int, bot: BinaryBot | None = None) -> dict[str, Any]:
    tf, horizon = EXPIRY_BARS[expiry_seconds]
    svc = MarketService(db)
    inst = await svc.get(symbol)
    bars = await svc.candles(inst, tf, HISTORY_BARS)
    cfg = config()
    sig = compute_signal([b.open_time for b in bars], [float(b.high) for b in bars], [float(b.low) for b in bars],
                         [float(b.close) for b in bars], horizon, payout=cfg["payout_rate"],
                         min_confidence=bot.min_confidence if bot else 0.6, edge_margin=bot.edge_margin if bot else 0.02)
    return {**sig, "symbol": inst.symbol, "expiry_seconds": expiry_seconds, "timeframe": tf, "bars": len(bars),
            "data_mode": get_settings().market_data_mode}


async def get_bot(db: AsyncSession, account_id, lock: bool = False) -> BinaryBot:
    stmt = select(BinaryBot).where(BinaryBot.account_id == account_id)
    if lock:
        stmt = stmt.with_for_update()
    bot = await db.scalar(stmt)
    if bot is None:
        bot = BinaryBot(account_id=account_id, status="STOPPED", symbols=list(DEFAULT_SYMBOLS), expiry_seconds=60,
                        stake_pct=1.0, min_confidence=0.6, edge_margin=0.02, guard_min_contracts=20, allow_synthetic=True)
        db.add(bot)
        await db.flush()
    return bot


async def bot_stats(db: AsyncSession, bot: BinaryBot) -> dict[str, Any]:
    """Bot contracts since it was last started (the edge guard's window)."""
    stmt = select(BinaryContract).where(BinaryContract.account_id == bot.account_id, BinaryContract.source == "bot")
    if bot.started_at:
        stmt = stmt.where(BinaryContract.created_at >= bot.started_at)
    rows = list(await db.scalars(stmt))
    won = sum(c.status == BinaryStatus.WON for c in rows)
    lost = sum(c.status == BinaryStatus.LOST for c in rows)
    settled = [c for c in rows if c.status != BinaryStatus.OPEN]
    staked = sum((c.stake for c in settled), Decimal(0))
    net = sum((c.pnl or Decimal(0) for c in settled), Decimal(0))
    return {"contracts": len(rows), "open": len(rows) - len(settled), "won": won, "lost": lost,
            "ties": sum(c.status == BinaryStatus.TIE for c in rows), "void": sum(c.status == BinaryStatus.VOID for c in rows),
            "win_rate": won / (won + lost) if won + lost else None, "staked": staked, "net_pnl": net,
            "return_on_stake": float(net / staked) if staked else None}


def pause(risk: RiskService, bot: BinaryBot, reason: str) -> None:
    if bot.status == "RUNNING":
        bot.status, bot.paused_reason = "PAUSED", reason
        risk.event(bot.account_id, "BINARY_BOT_PAUSED", f"Binary bot paused: {reason}")


async def run_bot_cycle(db: AsyncSession, acct: TradingAccount, bot: BinaryBot) -> dict[str, Any]:
    risk = RiskService(db)
    now = datetime.now(UTC)
    out: dict[str, Any] = {"at": now.isoformat(), "results": []}
    bot.last_cycle_at = now
    prof = await risk.profile(acct.id)
    block = await risk.block_reason(prof)
    if block or not prof.binary_enabled:
        reason = block or "binary trading is switched off in the Risk Centre"
        pause(risk, bot, reason)
        out["skipped"] = reason
        await db.flush()
        return out
    stats = await bot_stats(db, bot)
    be = config()["break_even_win_rate"]
    if stats["won"] + stats["lost"] >= bot.guard_min_contracts and stats["win_rate"] < be:
        reason = (f"edge guard: won {stats['won']} of {stats['won'] + stats['lost']} ({stats['win_rate']:.1%}), "
                  f"below the {be:.1%} break-even rate")
        pause(risk, bot, reason)
        out["skipped"] = reason
        await db.flush()
        return out

    user = await db.get(User, acct.owner_id)
    svc = BinaryService(db)
    for symbol in bot.symbols:
        open_here = await db.scalar(select(func.count()).select_from(BinaryContract).where(
            BinaryContract.account_id == acct.id, BinaryContract.source == "bot", BinaryContract.symbol == symbol,
            BinaryContract.status == BinaryStatus.OPEN))
        if open_here:
            out["results"].append({"symbol": symbol, "outcome": "waiting", "detail": "a bot contract on this instrument is still open"})
            continue
        try:
            sig = await signal_for(db, symbol, bot.expiry_seconds, bot)
        except AppError as e:
            out["results"].append({"symbol": symbol, "outcome": "error", "detail": e.message})
            continue
        brief = {k: sig[k] for k in ("p_up", "confidence", "holdout_accuracy", "holdout_n", "required_accuracy", "expected_return",
                                     "timeframe", "data_mode")}
        if not sig["trade"]:
            out["results"].append({"symbol": symbol, "outcome": "no_trade", "detail": sig["reason"], "signal": brief})
            continue
        summary = await svc.trading.summary(acct, take_snapshot=False)
        stake = (summary["equity"] * Decimal(str(bot.stake_pct)) / 100).quantize(CENT, rounding=ROUND_DOWN)
        stake = max(stake, Decimal(config()["minimum_stake"]))    # small accounts stake the minimum; the gate still caps it
        try:
            c, _ = await svc.open(user, BinaryRequest(
                account_id=acct.id, symbol=symbol, direction=sig["direction"], stake=stake, expiry_seconds=bot.expiry_seconds,
                client_id=f"bot-{uuid.uuid4().hex}",
                source="bot", signal={**brief, "reason": sig["reason"]}))
            out["results"].append({"symbol": symbol, "outcome": "opened", "contract_id": str(c.id), "direction": c.direction,
                                   "stake": str(c.stake), "detail": sig["reason"], "signal": brief})
        except AppError as e:
            out["results"].append({"symbol": symbol, "outcome": "risk_rejected", "detail": e.message, "signal": brief})
    n = sum(r["outcome"] == "opened" for r in out["results"])
    risk.event(acct.id, "BINARY_BOT_CYCLE", f"Binary bot: {len(out['results'])} instruments checked, {n} contracts opened",
               results=out["results"])
    await db.flush()
    return out


async def due_bots(db: AsyncSession) -> list[tuple[TradingAccount, BinaryBot]]:
    now = datetime.now(UTC)
    out = []
    for bot in await db.scalars(select(BinaryBot).where(BinaryBot.status == "RUNNING").with_for_update(skip_locked=True)):
        if bot.last_cycle_at is None or (now - bot.last_cycle_at).total_seconds() >= cycle_interval(bot):
            out.append((await db.get(TradingAccount, bot.account_id), bot))
    return out


async def recent_cycles(db: AsyncSession, account_id, limit: int = 15) -> list[dict[str, Any]]:
    rows = await db.scalars(select(RiskEvent).where(RiskEvent.account_id == account_id,
                                                    RiskEvent.type.in_(["BINARY_BOT_CYCLE", "BINARY_BOT_PAUSED", "BINARY_BOT_CONTROL"]))
                            .order_by(RiskEvent.created_at.desc()).limit(limit))
    return [{"at": e.created_at, "type": e.type, "message": e.message, "results": e.detail.get("results", [])} for e in rows]
