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

import math
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
HISTORY_BARS = 3000       # about two days of 1-minute bars
MIN_HOLDOUT = 60          # confident out-of-sample predictions needed before trusting the hit rate
MIN_USABLE = 400
FOLDS = 5
EARLY_GUARD = 8           # settled contracts after which a clearly losing bot pauses (statistical guard)
CENT = Decimal("0.01")


def wilson_bounds(hits: int, n: int, z: float = 1.96) -> tuple[float, float]:
    """95% Wilson interval for a hit rate: how sure we can be, given only n predictions."""
    if n == 0:
        return 0.0, 1.0
    p = hits / n
    centre = (p + z * z / (2 * n)) / (1 + z * z / n)
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / (1 + z * z / n)
    return max(0.0, centre - half), min(1.0, centre + half)


def compute_signal(times: list[datetime], high: list[float], low: list[float], close: list[float], horizon: int, *,
                   payout: float, min_confidence: float, edge_margin: float, folds: int = FOLDS) -> dict[str, Any]:
    """Pure: walk-forward validate, then predict the next contract. No I/O.

    The bot trades only when ALL of these hold on predictions made out of sample (each fold trained
    only on earlier bars, with a purge gap):
      1. at least MIN_HOLDOUT confident predictions in total;
      2. the 95% lower bound of their hit rate is above break-even (one lucky stretch is not enough);
      3. the hit rate itself clears break-even plus the safety margin;
      4. most folds (time periods) beat break-even on their own: the edge is consistent, not one regime;
      5. today's prediction is at least as confident as the threshold.
    """
    from sklearn.linear_model import LogisticRegression
    from sklearn.pipeline import make_pipeline
    from sklearn.preprocessing import StandardScaler

    break_even = 1 / (1 + payout)
    threshold = max(min_confidence, break_even)
    required = break_even + edge_margin
    out: dict[str, Any] = {"break_even": break_even, "required_accuracy": required, "confidence_threshold": threshold,
                           "trade": False, "direction": None, "p_up": None, "confidence": None,
                           "holdout_accuracy": None, "holdout_lower": None, "holdout_n": 0, "train_n": 0,
                           "folds": 0, "folds_beating": 0, "expected_return": None}
    if len(close) <= WARMUP + horizon:
        return {**out, "reason": f"not enough history: 0 usable bars (need {MIN_USABLE}; have {len(close)} bars)"}
    ds = build_dataset(times, high, low, close, horizon)
    n = len(ds.y)
    if n < MIN_USABLE:
        return {**out, "reason": f"not enough history: {n} usable bars (need {MIN_USABLE})"}

    def model():
        return make_pipeline(StandardScaler(), LogisticRegression(C=0.5, max_iter=500))

    start = int(n * 0.5)
    size = (n - start) // folds
    hits_total, picks_total, fold_rates = 0, 0, []
    for k in range(folds):
        s0 = start + k * size
        e0 = n if k == folds - 1 else s0 + size
        tr_end = s0 - horizon                                   # purge: no training label overlaps the test block
        if len(set(ds.y[:tr_end])) < 2:
            continue
        m = model().fit(ds.X[:tr_end], ds.y[:tr_end])
        p = m.predict_proba(ds.X[s0:e0])[:, 1]
        sel = np.maximum(p, 1 - p) >= threshold
        hits = ((p >= 0.5).astype(int) == ds.y[s0:e0])[sel]
        hits_total += int(hits.sum())
        picks_total += int(sel.sum())
        if sel.sum() >= 5:
            fold_rates.append(float(hits.mean()))
    acc = hits_total / picks_total if picks_total else None
    lower, _ = wilson_bounds(hits_total, picks_total)
    beating = sum(r > break_even for r in fold_rates)
    out.update(holdout_n=picks_total, holdout_accuracy=acc, holdout_lower=lower if picks_total else None,
               train_n=start - horizon, folds=len(fold_rates), folds_beating=beating)

    final = model().fit(ds.X, ds.y)                             # refit on everything for today's call
    row = latest_features(times, high, low, close)
    if row is None:
        return {**out, "reason": "latest bar has incomplete features"}
    p = float(final.predict_proba(row.reshape(1, -1))[0, 1])
    conf = max(p, 1 - p)
    out.update(p_up=p, confidence=conf, direction="HIGHER" if p >= 0.5 else "LOWER",
               expected_return=(acc * payout - (1 - acc)) if acc is not None else None)
    need_folds = max(3, math.ceil(0.75 * len(fold_rates)))
    if picks_total < MIN_HOLDOUT:
        out["reason"] = f"too few confident out-of-sample predictions to judge ({picks_total} < {MIN_HOLDOUT})"
    elif lower < break_even:
        out["reason"] = (f"no proven edge: hit rate {acc:.1%} on {picks_total} out-of-sample calls, but the 95% range "
                         f"starts at {lower:.1%}, below the {break_even:.1%} break-even")
    elif acc < required:
        out["reason"] = f"no validated edge: out-of-sample hit rate {acc:.1%} < {required:.1%} needed"
    elif beating < need_folds:
        out["reason"] = f"edge not consistent: only {beating} of {len(fold_rates)} time periods beat break-even (need {need_folds})"
    elif conf < threshold:
        out["reason"] = f"not confident enough now: {conf:.1%} < {threshold:.1%}"
    else:
        out["trade"] = True
        out["reason"] = (f"edge validated: {acc:.1%} hit rate (95% range from {lower:.1%}) on {picks_total} out-of-sample calls, "
                         f"{beating}/{len(fold_rates)} periods above break-even; now {conf:.1%} {out['direction']}")
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


FUTURES_SIDE = {"HIGHER": "LONG", "LOWER": "SHORT"}


async def futures_agreement(db: AsyncSession, symbol: str, direction: str) -> tuple[bool, str, dict[str, Any] | None]:
    """Does the AI futures model (hourly bars, 4-hour horizon) point the same way with at least its own
    55% confidence? A trend filter: the short binary call must go with the bigger move, not against it."""
    from app.futures import bot as fbot
    from app.futures.signal import CONFIDENCE
    try:
        inst = await MarketService(db).get(symbol)
        if inst.asset_class != "CRYPTO":
            return False, "the futures model covers crypto only, so it cannot confirm this market", None
        f = await fbot.signal_for(db, symbol)
    except AppError as e:
        return False, f"the futures model is unavailable ({e.message})", None
    fut = {"direction": f.get("direction"), "confidence": f.get("confidence"), "trade": f.get("trade")}
    want = FUTURES_SIDE[direction]
    if f.get("direction") is None or f.get("confidence") is None:
        return False, "the futures model has no view right now", fut
    if f["direction"] != want:
        return False, f"the futures model disagrees ({f['confidence']:.0%} {f['direction']}, the binary model wants {want})", fut
    if f["confidence"] < CONFIDENCE:
        return False, f"the futures model leans {want} but only {f['confidence']:.0%} (needs {CONFIDENCE:.0%})", fut
    return True, f"the futures model agrees ({f['confidence']:.0%} {want})", fut


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
    decided = stats["won"] + stats["lost"]
    upper = wilson_bounds(stats["won"], decided)[1] if decided else 1.0
    if decided >= EARLY_GUARD and upper < be:
        reason = (f"edge guard: won {stats['won']} of {decided}; even the best case of that record "
                  f"({upper:.1%}) is below the {be:.1%} break-even")
        pause(risk, bot, reason)
        out["skipped"] = reason
        await db.flush()
        return out
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
        brief = {k: sig.get(k) for k in ("p_up", "confidence", "holdout_accuracy", "holdout_lower", "holdout_n", "folds", "folds_beating", "required_accuracy", "expected_return",
                                     "timeframe", "data_mode")}
        if not sig["trade"]:
            out["results"].append({"symbol": symbol, "outcome": "no_trade", "detail": sig["reason"], "signal": brief})
            continue
        if bot.require_futures_agreement:
            agrees, why, fut = await futures_agreement(db, symbol, sig["direction"])
            brief["futures"] = fut
            if not agrees:
                out["results"].append({"symbol": symbol, "outcome": "no_trade", "detail": f"{sig['reason']}; skipped: {why}", "signal": brief})
                continue
            sig = {**sig, "reason": f"{sig['reason']}; {why}"}
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
