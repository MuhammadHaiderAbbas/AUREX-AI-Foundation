"""Risk service: gathers state for the pure engine, records decisions, trips breakers.

Breakers are measured on *trading* equity (equity minus net virtual contributions), so
depositing or withdrawing virtual cash can neither trip nor mask a breaker.
"""

import uuid
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import BusinessRuleViolation
from app.models import (
    AutopilotStatus,
    Order,
    OrderEvent,
    OrderStatus,
    RiskDecision,
    RiskEvent,
    RiskProfile,
    SystemControl,
    TradingAccount,
)
from app.models.ledger import LedgerCode
from app.risk import engine
from app.services.ledger_service import LedgerService

HALT_KEY = "trading_halt"
LIMIT_FIELDS = tuple(engine.DEFAULTS)
DEFAULT_AUTOPILOT_SYMBOLS = ["BTC-USD", "ETH-USD", "SPY"]


def limits_of(p: RiskProfile) -> engine.Limits:
    return engine.Limits(**{k: getattr(p, k) for k in LIMIT_FIELDS})


class RiskService:
    def __init__(self, db: AsyncSession):
        self.db = db
        self.ledger = LedgerService(db)

    # -- state ------------------------------------------------------------------------------
    async def profile(self, account_id: uuid.UUID, lock: bool = False) -> RiskProfile:
        stmt = select(RiskProfile).where(RiskProfile.account_id == account_id)
        if lock:
            stmt = stmt.with_for_update()
        p = await self.db.scalar(stmt)
        if p is None:
            p = RiskProfile(account_id=account_id, **engine.DEFAULTS, kill_switch=False, drawdown_halted=False, binary_enabled=True,
                            autopilot_status=AutopilotStatus.STOPPED, autopilot_symbols=list(DEFAULT_AUTOPILOT_SYMBOLS))
            self.db.add(p)
            await self.db.flush()
        return p

    async def system_halt(self) -> dict[str, Any]:
        row = await self.db.get(SystemControl, HALT_KEY)
        return row.value if row else {"halted": False, "reason": None, "since": None}

    async def set_system_halt(self, halted: bool, reason: str | None, actor: uuid.UUID) -> dict[str, Any]:
        row = await self.db.get(SystemControl, HALT_KEY, with_for_update=True)
        value = {"halted": halted, "reason": reason if halted else None,
                 "since": datetime.now(UTC).isoformat() if halted else None}
        if row is None:
            self.db.add(SystemControl(key=HALT_KEY, value=value, updated_by=actor))
        else:
            row.value, row.updated_by = value, actor
        self.event(None, "SYSTEM_HALT" if halted else "SYSTEM_RESUME",
                   f"Platform trading {'halted' if halted else 'resumed'}" + (f": {reason}" if halted and reason else ""),
                   actor=actor)
        if halted:
            accts = await self.db.scalars(select(TradingAccount.id))
            for aid in accts:
                await self.cancel_open(aid, "risk: platform trading halted", buys_only=True)
                prof = await self.db.get(RiskProfile, aid)
                if prof and prof.autopilot_status == AutopilotStatus.RUNNING:
                    prof.autopilot_status = AutopilotStatus.PAUSED
        await self.db.flush()
        return value

    def event(self, account_id: uuid.UUID | None, type_: str, message: str, actor: uuid.UUID | None = None,
              **detail: Any) -> None:
        self.db.add(RiskEvent(account_id=account_id, type=type_, message=message, actor_user_id=actor,
                              detail={k: str(v) if isinstance(v, Decimal) else v for k, v in detail.items()}))

    async def cancel_open(self, account_id: uuid.UUID, reason: str, buys_only: bool = True) -> int:
        stmt = select(Order).where(Order.account_id == account_id, Order.status == OrderStatus.OPEN)
        if buys_only:
            stmt = stmt.where(Order.side == "BUY")
        n = 0
        for o in await self.db.scalars(stmt.with_for_update()):
            o.status = OrderStatus.CANCELLED
            o.reject_reason = reason
            self.db.add(OrderEvent(order_id=o.id, type="CANCELLED", detail={"by": "risk", "reason": reason}))
            n += 1
        await self.db.flush()
        return n

    # -- equity tracking and breakers -------------------------------------------------------------
    async def metrics(self, acct: TradingAccount, summary: dict[str, Any], prof: RiskProfile | None = None) -> dict[str, Any]:
        """Update day/peak baselines from the latest valuation and trip breakers if needed."""
        prof = prof or await self.profile(acct.id, lock=True)
        lines = {ln["code"]: ln["balance"] for ln in (await self.ledger.balances([acct.id]))[acct.id]}
        net_contrib = lines.get(LedgerCode.CAPITAL_CONTRIBUTIONS, Decimal(0)) + lines.get(LedgerCode.CAPITAL_WITHDRAWALS, Decimal(0))
        equity: Decimal = summary["equity"]
        pnl_equity = equity - net_contrib
        today = datetime.now(UTC).date()
        if prof.day_date != today or prof.day_start_pnl_equity is None:
            prof.day_date, prof.day_start_pnl_equity, prof.day_start_equity = today, pnl_equity, equity
        if prof.peak_pnl_equity is None or pnl_equity > prof.peak_pnl_equity:
            prof.peak_pnl_equity = pnl_equity
        day_loss = prof.day_start_pnl_equity - pnl_equity
        day_base = prof.day_start_equity or equity
        daily_loss_pct = float(day_loss / day_base * 100) if day_base > 0 else 0.0
        dd = prof.peak_pnl_equity - pnl_equity
        dd_base = prof.peak_pnl_equity + net_contrib
        drawdown_pct = float(dd / dd_base * 100) if dd_base > 0 else 0.0
        positions = summary["positions"]
        largest = max((p["market_value"] for p in positions), default=Decimal(0))

        if daily_loss_pct >= prof.daily_loss_limit_pct and prof.daily_halt_date != today:
            prof.daily_halt_date = today
            await self._trip(acct, prof, "BREAKER_DAILY_LOSS",
                             f"Daily loss breaker tripped: −{daily_loss_pct:.2f}% (limit {prof.daily_loss_limit_pct:g}%)",
                             loss_pct=round(daily_loss_pct, 4), equity=equity)
        if drawdown_pct >= prof.max_drawdown_pct and not prof.drawdown_halted:
            prof.drawdown_halted, prof.drawdown_halted_at = True, datetime.now(UTC)
            await self._trip(acct, prof, "BREAKER_DRAWDOWN",
                             f"Drawdown breaker tripped: −{drawdown_pct:.2f}% from peak (limit {prof.max_drawdown_pct:g}%)",
                             drawdown_pct=round(drawdown_pct, 4), peak=prof.peak_pnl_equity, equity=equity)
        await self.db.flush()
        return {
            "equity": equity, "pnl_equity": pnl_equity, "peak_pnl_equity": prof.peak_pnl_equity,
            "day_start_equity": prof.day_start_equity, "daily_pnl": -day_loss, "daily_loss_pct": max(0.0, daily_loss_pct),
            "drawdown_pct": max(0.0, drawdown_pct), "exposure_pct": summary["exposure"] * 100,
            "largest_position_pct": float(largest / equity * 100) if equity > 0 else 0.0,
            "open_positions": len(positions),
        }

    async def _trip(self, acct: TradingAccount, prof: RiskProfile, type_: str, message: str, **detail: Any) -> None:
        cancelled = await self.cancel_open(acct.id, f"risk: {message}", buys_only=True)
        if prof.autopilot_status == AutopilotStatus.RUNNING:
            prof.autopilot_status = AutopilotStatus.PAUSED
        self.event(acct.id, type_, message, cancelled_orders=cancelled, **detail)

    def is_daily_halted(self, prof: RiskProfile) -> bool:
        return prof.daily_halt_date == datetime.now(UTC).date()

    async def block_reason(self, prof: RiskProfile) -> str | None:
        """Why exposure-increasing activity is blocked right now, if it is."""
        halt = await self.system_halt()
        if halt["halted"]:
            return f"platform trading is halted: {halt['reason']}"
        if prof.kill_switch:
            return f"account kill switch is engaged: {prof.kill_reason}"
        if self.is_daily_halted(prof):
            return f"daily loss limit of {prof.daily_loss_limit_pct:g}% reached"
        if prof.drawdown_halted:
            return f"maximum drawdown of {prof.max_drawdown_pct:g}% reached"
        return None

    # -- the gate ---------------------------------------------------------------------------------
    async def pre_trade(self, acct: TradingAccount, order: Order, *, asset_class: str, entry: Decimal, fx: Decimal,
                        bid: Decimal | None, ask: Decimal | None, summary: dict[str, Any], reserved_buys: Decimal,
                        open_buy_symbols: set[str], held_qty: Decimal) -> tuple[bool, list[dict], str | None]:
        prof = await self.profile(acct.id, lock=True)
        await self.metrics(acct, summary, prof)
        halt = await self.system_halt()
        reduces = order.side == "SELL" and held_qty > 0
        notional = order.quantity * entry * fx
        stop = order.stop_loss if order.stop_loss is not None else entry * (1 - engine.DEFAULT_STOP_PCT[asset_class] / 100)
        risk_amount = order.quantity * max(entry - stop, Decimal(0)) * fx
        current = next((p["market_value"] for p in summary["positions"] if p["symbol"] == order.symbol), Decimal(0))
        held_symbols = {p["symbol"] for p in summary["positions"]}
        collar = None
        if order.type == "LIMIT" and order.limit_price is not None:
            if order.side == "BUY" and ask:
                collar = float((order.limit_price / ask - 1) * 100)
            elif order.side == "SELL" and bid:
                collar = float((1 - order.limit_price / bid) * 100)
        recent = await self.db.scalar(select(func.count()).select_from(Order).where(
            Order.account_id == acct.id, Order.id != order.id, Order.source != "protective",
            Order.created_at >= datetime.now(UTC) - timedelta(seconds=60)))
        inputs = engine.PreTrade(
            side=order.side, reduces=reduces, system_halt=(halt["reason"] or "halted") if halt["halted"] else None,
            kill_switch=(prof.kill_reason or "engaged") if prof.kill_switch else None,
            daily_halted=self.is_daily_halted(prof), drawdown_halted=prof.drawdown_halted,
            equity=summary["equity"], notional=notional, risk_amount=risk_amount,
            position_after=current + notional, exposure_after=summary["market_value"] + reserved_buys + notional,
            open_positions_after=len(held_symbols | open_buy_symbols | {order.symbol}),
            collar_through_pct=collar, orders_last_minute=int(recent or 0))
        checks = engine.evaluate(inputs, limits_of(prof))
        reason = engine.first_failure(checks)
        rate = next(c for c in checks if c.name == "order_rate")
        if not rate.passed and not prof.kill_switch:
            await self.engage_kill_switch(acct, prof, rate.message, actor=None, automatic=True)
        self.db.add(RiskDecision(account_id=acct.id, order_id=order.id, proposal_id=order.proposal_id, source=order.source,
                                 symbol=order.symbol, side=order.side, approved=reason is None, reason=reason,
                                 checks=[c.dict() for c in checks]))
        await self.db.flush()
        return reason is None, [c.dict() for c in checks], reason

    # -- controls -----------------------------------------------------------------------------------
    async def engage_kill_switch(self, acct: TradingAccount, prof: RiskProfile, reason: str, actor: uuid.UUID | None,
                                 automatic: bool = False) -> None:
        prof.kill_switch, prof.kill_reason, prof.kill_engaged_at = True, reason, datetime.now(UTC)
        if prof.autopilot_status == AutopilotStatus.RUNNING:
            prof.autopilot_status = AutopilotStatus.PAUSED
        cancelled = await self.cancel_open(acct.id, f"risk: kill switch engaged ({reason})", buys_only=True)
        self.event(acct.id, "ABNORMAL_ACTIVITY" if automatic else "KILL_SWITCH_ON",
                   f"Kill switch engaged{' automatically' if automatic else ''}: {reason}", actor=actor,
                   cancelled_orders=cancelled)
        await self.db.flush()

    async def release_kill_switch(self, acct: TradingAccount, prof: RiskProfile, actor: uuid.UUID) -> None:
        if not prof.kill_switch:
            raise BusinessRuleViolation("Kill switch is not engaged")
        prof.kill_switch, prof.kill_reason, prof.kill_engaged_at = False, None, None
        self.event(acct.id, "KILL_SWITCH_OFF", "Kill switch released", actor=actor)
        await self.db.flush()

    async def reset_drawdown(self, acct: TradingAccount, prof: RiskProfile, summary: dict[str, Any], actor: uuid.UUID) -> None:
        if not prof.drawdown_halted:
            raise BusinessRuleViolation("Drawdown breaker is not tripped")
        prof.drawdown_halted, prof.drawdown_halted_at, prof.peak_pnl_equity = False, None, None
        await self.metrics(acct, summary, prof)   # re-baselines the peak at current trading equity
        self.event(acct.id, "BREAKER_RESET", "Drawdown breaker reset; peak re-based to current equity", actor=actor)
        await self.db.flush()

    async def update_limits(self, acct: TradingAccount, prof: RiskProfile, changes: dict[str, Any], actor: uuid.UUID) -> dict:
        diff = {}
        enabled = changes.get("binary_enabled")
        if enabled is not None and enabled != prof.binary_enabled:
            diff["binary_enabled"] = {"from": prof.binary_enabled, "to": enabled}
            prof.binary_enabled = enabled
        for k, v in changes.items():
            if v is None or k not in LIMIT_FIELDS:
                continue
            if v <= 0 or v > engine.CEILINGS[k]:
                raise BusinessRuleViolation(f"{k} must be greater than 0 and at most {engine.CEILINGS[k]}")
            old = getattr(prof, k)
            if old != v:
                diff[k] = {"from": old, "to": v}
                setattr(prof, k, v)
        if diff:
            loosened = [k for k, d in diff.items() if d["to"] > d["from"]]   # True > False: enabling binaries loosens
            self.event(acct.id, "LIMITS_CHANGED", "Risk limits changed" + (f" (loosened: {', '.join(loosened)})" if loosened else ""),
                       actor=actor, changes=diff)
        await self.db.flush()
        return diff
