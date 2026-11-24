"""Assembles analytics from the ledger, snapshots, executions, risk logs and agent runs.

Everything here is derived from append-only or immutable records, so a report can always be
re-generated and compared (each full report carries a SHA-256 of its content).
"""

import hashlib
import json
from bisect import bisect_right
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.analytics import metrics as m
from app.core.errors import BusinessRuleViolation
from app.market.service import ProviderUnavailable
from app.models import (
    AIRun,
    Execution,
    Instrument,
    ModelEvaluation,
    ModelVersion,
    Order,
    PortfolioSnapshot,
    Position,
    RiskDecision,
    RiskEvent,
    TradeProposal,
    TradingAccount,
)
from app.models.ledger import LedgerAccount, LedgerEntry, LedgerTransaction, TransactionType
from app.services.ledger_service import LedgerService
from app.trading.service import TradingService

PERIODS = {"7d": 7, "30d": 30, "90d": 90, "365d": 365, "all": None}
BUSINESS_REASONS = [
    ("insufficient cash", "Insufficient cash"), ("insufficient position", "No position / short"),
    ("market is closed", "Market closed"), ("stale", "Stale quote"), ("no market data", "No market data"),
    ("FX", "No FX rate"), ("stop_loss", "Invalid bracket"), ("take_profit", "Invalid bracket"),
]


def period_start(period: str, created_at: datetime) -> datetime:
    if period not in PERIODS:
        raise BusinessRuleViolation(f"period must be one of {', '.join(PERIODS)}")
    days = PERIODS[period]
    start = datetime.now(UTC) - timedelta(days=days) if days else created_at
    return max(start, created_at)


def _f(x: Any) -> Any:
    return float(x) if isinstance(x, Decimal) else x


class AnalyticsService:
    def __init__(self, db: AsyncSession):
        self.db = db
        self.trading = TradingService(db)
        self.market = self.trading.market
        self._insts: dict[str, Instrument] | None = None

    async def inst(self, symbol: str) -> Instrument | None:
        if self._insts is None:
            self._insts = {i.symbol: i for i in await self.db.scalars(select(Instrument))}
        return self._insts.get(symbol)

    # -- equity and returns ------------------------------------------------------------------------
    async def _flows(self, acct: TradingAccount) -> tuple[dict[date, float], float]:
        rows = await self.db.execute(
            select(LedgerTransaction.type, LedgerTransaction.created_at, LedgerEntry.amount)
            .join(LedgerEntry, LedgerEntry.transaction_id == LedgerTransaction.id)
            .join(LedgerAccount, LedgerAccount.id == LedgerEntry.ledger_account_id)
            .where(LedgerTransaction.trading_account_id == acct.id, LedgerAccount.code == "CASH",
                   LedgerTransaction.type.in_([TransactionType.INITIAL_FUNDING, TransactionType.VIRTUAL_DEPOSIT,
                                               TransactionType.VIRTUAL_WITHDRAWAL])))
        flows: dict[date, float] = {}
        opening = 0.0
        for type_, at, amount in rows:
            if type_ == TransactionType.INITIAL_FUNDING:
                opening += float(amount)
                continue
            sign = 1 if type_ == TransactionType.VIRTUAL_DEPOSIT else -1
            flows[at.date()] = flows.get(at.date(), 0.0) + sign * float(amount)
        return flows, opening

    async def performance(self, acct: TradingAccount, period: str, benchmark: str | None = "SPY") -> dict[str, Any]:
        since = period_start(period, acct.created_at)
        flows, opening = await self._flows(acct)
        snaps = await self.db.execute(select(PortfolioSnapshot.taken_at, PortfolioSnapshot.equity)
                                      .where(PortfolioSnapshot.account_id == acct.id).order_by(PortfolioSnapshot.taken_at))
        now_eq = (await self.trading.summary(acct, take_snapshot=False))["equity"]
        points = [(acct.created_at, opening), *[(t, float(e)) for t, e in snaps], (datetime.now(UTC), float(now_eq))]
        days = m.daily_points(points)
        rets = [(d, r) for d, r in m.daily_returns(days, flows) if d > since.date()]
        perf = m.performance([r for _, r in rets])
        curve = [{"t": t.isoformat(), "equity": e} for t, e in points if t >= since]
        if not curve or curve[0]["t"] != since.isoformat():
            base = next((e for t, e in reversed(points) if t <= since), opening)
            curve.insert(0, {"t": since.isoformat(), "equity": base})
        growth, g = [], 1.0
        for d, r in rets:
            g *= 1 + r
            growth.append({"date": d.isoformat(), "return": r, "growth": g, "flow": flows.get(d, 0.0)})
        dd = m.drawdowns([1.0, *[x["growth"] for x in growth]])[1:]
        for x, v in zip(growth, dd, strict=True):
            x["drawdown"] = v
        notes = []
        if perf["periods"] < m.MIN_PERIODS:
            notes.append(f"Only {perf['periods']} daily returns in this period: Sharpe, Sortino, volatility and CAGR need at least {m.MIN_PERIODS}.")
        notes.append("Returns are time-weighted and exclude virtual deposits and withdrawals. Days without a valuation carry the last known equity.")
        return {"period": period, "since": since.isoformat(), "currency": acct.base_currency, "metrics": perf,
                "curve": curve, "daily": growth, "benchmark": await self._benchmark(benchmark, since) if benchmark else None,
                "notes": notes}

    async def _benchmark(self, symbol: str, since: datetime) -> dict[str, Any] | None:
        try:
            inst = await self.market.get(symbol)
            days = max(2, min(1000, (datetime.now(UTC) - since).days + 3))
            candles = await self.market.candles(inst, "1d", days)
        except ProviderUnavailable:
            return {"symbol": symbol, "available": False}
        rows = [(c.open_time, float(c.close)) for c in candles if c.open_time.date() >= since.date()]
        if len(rows) < 2:
            return {"symbol": inst.symbol, "available": False}
        base = rows[0][1]
        return {"symbol": inst.symbol, "available": True, "return": rows[-1][1] / base - 1,
                "curve": [{"date": t.date().isoformat(), "growth": v / base} for t, v in rows]}

    # -- round trips ---------------------------------------------------------------------------------
    async def round_trips(self, acct: TradingAccount, since: datetime) -> list[dict[str, Any]]:
        positions = await self.db.scalars(select(Position).where(
            Position.account_id == acct.id, Position.status == "CLOSED", Position.closed_at >= since)
            .order_by(Position.closed_at))
        out = []
        for p in positions:
            exes = list(await self.db.scalars(select(Execution).where(
                Execution.account_id == acct.id, Execution.symbol == p.symbol,
                Execution.executed_at >= p.opened_at - timedelta(seconds=1),
                Execution.executed_at <= p.closed_at + timedelta(seconds=1)).order_by(Execution.executed_at)))
            buys = [x for x in exes if x.side == "BUY"]
            sells = [x for x in exes if x.side == "SELL"]
            entry = await self.db.get(Order, buys[0].order_id) if buys else None
            exit_ = await self.db.get(Order, sells[-1].order_id) if sells else None
            how = "manual"
            if exit_ is not None:
                how = ({"STOP": "stop", "LIMIT": "target"}.get(exit_.type, "protective") if exit_.source == "protective"
                       else exit_.source)
            inst = await self.inst(p.symbol)
            out.append({
                "symbol": p.symbol, "asset_class": inst.asset_class if inst else "", "source": entry.source if entry else "manual",
                "exit": how, "opened_at": p.opened_at, "closed_at": p.closed_at,
                "pnl": float(p.realised_pnl - p.fees), "gross_pnl": float(p.realised_pnl), "fees": float(p.fees),
                "cost": float(sum(x.quantity * x.price * x.fx_rate for x in buys)),
                "entry_order_id": entry.id if entry else None, "proposal_id": entry.proposal_id if entry else None,
            })
        return out

    async def trades(self, acct: TradingAccount, period: str) -> dict[str, Any]:
        since = period_start(period, acct.created_at)
        rows = await self.round_trips(acct, since)
        ts = [m.Trade(**{k: r[k] for k in ("symbol", "asset_class", "source", "exit", "opened_at", "closed_at", "pnl", "fees", "cost")})
              for r in rows]
        stats = {k: m.finite(v) for k, v in m.trade_stats(ts).items()}
        stats["no_losses"] = bool(ts) and stats["losses"] == 0
        open_pos = (await self.trading.summary(acct, take_snapshot=False))["positions"]
        return {
            "period": period, "since": since.isoformat(), "currency": acct.base_currency, "stats": stats,
            "by_symbol": [{k: m.finite(v) for k, v in g.items()} for g in m.group_stats(ts, "symbol")],
            "by_asset_class": [{k: m.finite(v) for k, v in g.items()} for g in m.group_stats(ts, "asset_class")],
            "by_source": [{k: m.finite(v) for k, v in g.items()} for g in m.group_stats(ts, "source")],
            "by_exit": [{k: m.finite(v) for k, v in g.items()} for g in m.group_stats(ts, "exit")],
            "trades": [{**{k: v for k, v in r.items() if k not in ("entry_order_id", "proposal_id")},
                        "opened_at": r["opened_at"].isoformat(), "closed_at": r["closed_at"].isoformat(),
                        "hold_hours": (r["closed_at"] - r["opened_at"]).total_seconds() / 3600} for r in reversed(rows)],
            "open": {"positions": len(open_pos), "unrealised_pnl": float(sum(p["unrealised_pnl"] for p in open_pos))},
        }

    # -- execution quality ---------------------------------------------------------------------------
    async def execution(self, acct: TradingAccount, period: str) -> dict[str, Any]:
        since = period_start(period, acct.created_at)
        exes = list(await self.db.scalars(select(Execution).where(Execution.account_id == acct.id, Execution.executed_at >= since)))
        groups: dict[str, dict[str, float]] = {}
        total = {"fills": 0, "notional": 0.0, "fees": 0.0, "spread": 0.0, "slippage": 0.0}
        for x in exes:
            inst = await self.inst(x.symbol)
            notional = float(x.quantity * x.price * x.fx_rate)
            for g in (total, groups.setdefault(inst.asset_class if inst else "?", {k: 0.0 for k in total})):
                g["fills"] += 1
                g["notional"] += notional
                g["fees"] += float(x.fee)
                g["spread"] += float(x.spread_cost)
                g["slippage"] += float(x.slippage_cost)

        def bps(g: dict[str, float]) -> dict[str, Any]:
            n = g["notional"]
            cost = g["fees"] + g["spread"] + g["slippage"]
            return {**g, "total_cost": cost, "cost_bps": cost / n * 1e4 if n else None,
                    "fee_bps": g["fees"] / n * 1e4 if n else None, "spread_bps": g["spread"] / n * 1e4 if n else None,
                    "slippage_bps": g["slippage"] / n * 1e4 if n else None}

        orders = list(await self.db.scalars(select(Order).where(Order.account_id == acct.id, Order.created_at >= since)))
        outcomes: dict[str, dict[str, int]] = {}
        for o in orders:
            row = outcomes.setdefault(o.source, {})
            row[o.status] = row.get(o.status, 0) + 1
        reasons: dict[str, int] = {}
        risk_first = {d.order_id: next((c["label"] for c in d.checks if not c["passed"]), "Risk")
                      for d in await self.db.scalars(select(RiskDecision).where(
                          RiskDecision.account_id == acct.id, RiskDecision.approved.is_(False), RiskDecision.created_at >= since))}
        for o in orders:
            if o.status != "REJECTED":
                continue
            if (o.reject_reason or "").startswith("risk:"):
                label = f"Risk: {risk_first.get(o.id, 'gate')}"
            else:
                label = next((lbl for key, lbl in BUSINESS_REASONS if key in (o.reject_reason or "")), "Other")
            reasons[label] = reasons.get(label, 0) + 1
        decided = [o for o in orders if o.status in ("FILLED", "REJECTED", "CANCELLED", "EXPIRED")]
        return {
            "period": period, "since": since.isoformat(), "currency": acct.base_currency, "total": bps(total),
            "by_asset_class": [{"key": k, **bps(v)} for k, v in sorted(groups.items())],
            "orders": {"total": len(orders), "fill_rate": (sum(o.status == "FILLED" for o in decided) / len(decided)) if decided else None,
                       "by_source": [{"source": k, **v} for k, v in sorted(outcomes.items())]},
            "rejections": sorted(({"reason": k, "count": v} for k, v in reasons.items()), key=lambda r: -r["count"]),
            "notes": ["Spread cost is the distance from mid to the bid/ask paid; slippage is the extra beyond the bid/ask. "
                      "Both use the cost model shared with the backtester."],
        }

    # -- risk ------------------------------------------------------------------------------------------
    async def risk(self, acct: TradingAccount, period: str) -> dict[str, Any]:
        since = period_start(period, acct.created_at)
        decisions = list(await self.db.scalars(select(RiskDecision).where(RiskDecision.account_id == acct.id,
                                                                          RiskDecision.created_at >= since)))
        failing: dict[str, int] = {}
        by_source: dict[str, dict[str, int]] = {}
        for d in decisions:
            row = by_source.setdefault(d.source, {"approved": 0, "rejected": 0})
            row["approved" if d.approved else "rejected"] += 1
            for c in d.checks:
                if not c["passed"]:
                    failing[c["label"]] = failing.get(c["label"], 0) + 1
        events = list(await self.db.scalars(select(RiskEvent).where(RiskEvent.account_id == acct.id, RiskEvent.created_at >= since)
                                            .order_by(RiskEvent.created_at)))
        counts: dict[str, int] = {}
        for e in events:
            counts[e.type] = counts.get(e.type, 0) + 1
        return {
            "period": period, "since": since.isoformat(), "decisions": len(decisions),
            "approved": sum(d.approved for d in decisions), "rejected": sum(not d.approved for d in decisions),
            "by_source": [{"source": k, **v} for k, v in sorted(by_source.items())],
            "failed_checks": sorted(({"check": k, "count": v} for k, v in failing.items()), key=lambda r: -r["count"]),
            "events": counts,
            "breaker_trips": [{"type": e.type, "message": e.message, "at": e.created_at.isoformat()}
                              for e in events if e.type.startswith("BREAKER_") and e.type != "BREAKER_RESET"
                              or e.type in ("ABNORMAL_ACTIVITY", "EMERGENCY_STOP")],
        }

    # -- AI quality ------------------------------------------------------------------------------------
    async def ai(self, acct: TradingAccount, period: str, horizon_hours: int = 24) -> dict[str, Any]:
        if not 1 <= horizon_hours <= 168:
            raise BusinessRuleViolation("horizon_hours must be between 1 and 168")
        since = period_start(period, acct.created_at)
        now = datetime.now(UTC)
        props = list(await self.db.scalars(select(TradeProposal).where(TradeProposal.account_id == acct.id,
                                                                       TradeProposal.created_at >= since)))
        status: dict[str, int] = {}
        for p in props:
            s = "EXPIRED" if p.status == "PENDING_RISK_REVIEW" and p.expires_at <= now else p.status
            status[s] = status.get(s, 0) + 1
        conf = {p.id: p.confidence for p in props}
        trips = [r for r in await self.round_trips(acct, since) if r["proposal_id"] in conf]
        realised = m.calibration([(conf[r["proposal_id"]], r["pnl"] > 0) for r in trips])

        runs = list(await self.db.scalars(select(AIRun).where(AIRun.account_id == acct.id, AIRun.created_at >= since)
                                          .order_by(AIRun.created_at.desc()).limit(500)))
        h = timedelta(hours=horizon_hours)
        closes: dict[str, tuple[list[datetime], list[float]]] = {}
        evaluated: dict[str, list[tuple[float, float]]] = {"BUY": [], "NO_TRADE": []}
        pending = 0
        for r in runs:
            q = (r.context or {}).get("quote") or {}
            if not q.get("last"):
                continue
            if r.created_at + h > now:
                pending += 1
                continue
            if r.symbol not in closes:
                inst = await self.inst(r.symbol)
                try:
                    cs = await self.market.candles(inst, "1h", 1000) if inst else []
                except ProviderUnavailable:
                    cs = []
                closes[r.symbol] = ([c.open_time for c in cs], [float(c.close) for c in cs])
            times, values = closes[r.symbol]
            i = bisect_right(times, r.created_at + h) - 1
            if i < 0 or times[i] < r.created_at:
                continue
            evaluated.setdefault(r.decision, []).append((r.confidence, values[i] / float(q["last"]) - 1))

        def summary(rows: list[tuple[float, float]]) -> dict[str, Any]:
            n = len(rows)
            return {"n": n, "avg_forward_return": sum(x for _, x in rows) / n if n else None,
                    "hit_rate": sum(x > 0 for _, x in rows) / n if n else None}

        buy, flat = summary(evaluated["BUY"]), summary(evaluated["NO_TRADE"])
        edge = (buy["avg_forward_return"] - flat["avg_forward_return"]) if buy["n"] and flat["n"] else None
        champions = []
        for v in await self.db.scalars(select(ModelVersion).where(ModelVersion.status == "champion")):
            drift = await self.db.scalar(select(ModelEvaluation).where(ModelEvaluation.version_id == v.id,
                                                                       ModelEvaluation.kind == "drift_check")
                                         .order_by(ModelEvaluation.created_at.desc()).limit(1))
            champions.append({"symbol": v.symbol, "version": v.version, "eligible": v.eligible,
                              "note": v.eligibility_note, "last_drift_check": drift.created_at.isoformat() if drift else None,
                              "drift_status": drift.status if drift else None,
                              "max_psi": (drift.metrics or {}).get("max_psi") if drift else None})
        return {
            "period": period, "since": since.isoformat(), "horizon_hours": horizon_hours,
            "proposals": {"total": len(props), "by_status": status,
                          "execution_rate": (status.get("EXECUTED", 0) / len(props)) if props else None},
            "realised": {"closed_trades": len(trips), "net_pnl": sum(r["pnl"] for r in trips), "calibration": realised},
            "signals": {"runs": len(runs), "pending": pending, "buy": buy, "no_trade": flat, "edge": edge,
                        "buy_calibration": m.calibration([(c, x > 0) for c, x in evaluated["BUY"]])},
            "models": champions,
            "notes": [f"Forward returns compare the price {horizon_hours}h after each run with the price the agents saw. "
                      "Agent confidence is a heuristic score, not a calibrated probability: these tables show how far it is from one."],
        }

    # -- full report -----------------------------------------------------------------------------------
    async def report(self, acct: TradingAccount, period: str, user_email: str) -> dict[str, Any]:
        bal = (await self.trading.ledger.balances([acct.id]))[acct.id]
        summary = await self.trading.summary(acct, take_snapshot=False)
        perf = await self.performance(acct, period)
        perf.pop("curve")   # the daily series is enough for a report
        body = {
            "report": "AUREX paper trading report", "version": 1, "generated_at": datetime.now(UTC).isoformat(),
            "account": {"id": str(acct.id), "name": acct.name, "currency": acct.base_currency, "mode": acct.mode,
                        "created_at": acct.created_at.isoformat(), "owner": user_email},
            "period": period,
            "snapshot": {k: _f(summary[k]) for k in ("cash", "market_value", "equity", "unrealised_pnl", "realised_pnl", "fees", "exposure", "open_positions")},
            "integrity": {"ledger_balanced": LedgerService.summarise(bal)["ledger_balanced"],
                          "ledger_lines": {ln["code"]: str(ln["balance"]) for ln in bal}},
            "performance": perf,
            "trades": await self.trades(acct, period),
            "execution": await self.execution(acct, period),
            "risk": await self.risk(acct, period),
            "ai": await self.ai(acct, period),
            "disclaimer": "Simulated paper trading with virtual capital. Past simulated performance does not predict future results.",
        }
        canonical = json.dumps(body, sort_keys=True, default=str, separators=(",", ":"))
        return {**body, "sha256": hashlib.sha256(canonical.encode()).hexdigest()}
