"""Paper perpetual futures: open, close, liquidation and funding (isolated margin).

Money flow (account currency, double entry):
  open     margin  INVESTMENTS dr / CASH cr;     taker fee  FEES dr / CASH cr
  close    margin back + P&L to CASH (loss capped at the margin); taker fee
  funding  every 8 hours, moves margin: longs pay shorts when the rate is positive
  liquidate  the whole margin is lost (REALISED_PNL dr / INVESTMENTS cr)

Liquidation price (quote currency), with M = margin in quote currency, Q = quantity, E = entry:
  long   E - (M - mmr*E*Q) / Q        short   E + (M - mmr*E*Q) / Q
which equals E*(1 - 1/L + mmr) for a long opened at leverage L. Funding changes M and so the price.
"""

import math
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import ROUND_DOWN, Decimal
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.errors import BusinessRuleViolation, NotFound
from app.futures import book as obook
from app.market.service import ProviderUnavailable, fx_rate
from app.models import FuturesPosition, FuturesStatus, Instrument, RiskDecision, TradingAccount, User
from app.models.ledger import Direction, LedgerCode, TransactionType
from app.services.ledger_service import Posting
from app.trading.service import TradingService

CENT = Decimal("0.01")
MONEY = Decimal("0.00000001")
MIN_MARGIN = Decimal("1.00")
FUNDING_HOURS = 8


class FuturesRejected(BusinessRuleViolation):
    def __init__(self, message: str, checks: list[dict]):
        super().__init__(message, details={"checks": checks}, code="risk_rejected")
        self.checks = checks


@dataclass
class OpenRequest:
    account_id: uuid.UUID
    symbol: str
    side: str                 # LONG | SHORT
    margin: Decimal           # account currency
    leverage: int
    client_id: str | None = None
    source: str = "manual"


def sign(side: str) -> int:
    return 1 if side == "LONG" else -1


def liquidation_price(side: str, entry: Decimal, qty: Decimal, margin_q: Decimal, mmr: Decimal) -> Decimal:
    cushion = (margin_q - mmr * entry * qty) / qty
    return max(Decimal(0), entry - cushion) if side == "LONG" else entry + cushion


def config() -> dict[str, Any]:
    s = get_settings()
    return {"max_leverage": s.futures_max_leverage, "taker_fee": s.futures_taker_fee, "maintenance_margin": s.futures_maintenance_margin,
            "funding_rate_8h": s.futures_funding_rate, "funding_interval_hours": FUNDING_HOURS, "max_margin_pct": s.futures_max_margin_pct,
            "max_total_margin_pct": s.futures_max_total_margin_pct, "max_open": s.futures_max_open, "minimum_margin": str(MIN_MARGIN)}


def next_funding(now: datetime) -> datetime:
    base = now.replace(minute=0, second=0, microsecond=0)
    hours = FUNDING_HOURS - base.hour % FUNDING_HOURS
    return base + timedelta(hours=hours)


class FuturesService:
    def __init__(self, db: AsyncSession):
        self.db = db
        self.trading = TradingService(db)
        self.market = self.trading.market
        self.ledger = self.trading.ledger
        self.risk = self.trading.risk

    async def instrument(self, symbol: str) -> Instrument:
        inst = await self.market.get(symbol)
        if inst.asset_class != "CRYPTO":
            raise BusinessRuleViolation("futures are available on crypto markets only")
        return inst

    async def _fx(self, inst: Instrument, acct: TradingAccount) -> Decimal:
        fx = await fx_rate(self.market, inst.quote_currency, acct.base_currency)
        if not fx:
            raise BusinessRuleViolation(f"no exchange rate from {inst.quote_currency} to {acct.base_currency}")
        return fx

    async def quote_fill(self, inst: Instrument, side_taking: str, quantity: Decimal) -> tuple[obook.Fill | None, str]:
        b = await obook.book(self.market, inst)
        return obook.walk(b["asks"] if side_taking == "BUY" else b["bids"], quantity), b["source"]

    async def preview(self, acct: TradingAccount, symbol: str, side: str, margin: Decimal, leverage: int) -> dict[str, Any]:
        inst = await self.instrument(symbol)
        q = await self.market.quote(inst)
        fx = await self._fx(inst, acct)
        notional_q = margin * leverage / fx
        ref_price = q.ask if side == "LONG" else q.bid
        lot = inst.lot_size
        qty = (notional_q / ref_price / lot).to_integral_value(rounding=ROUND_DOWN) * lot
        fill, source = await self.quote_fill(inst, "BUY" if side == "LONG" else "SELL", qty) if qty > 0 else (None, "none")
        cfg = config()
        out: dict[str, Any] = {"symbol": inst.symbol, "side": side, "leverage": leverage, "margin": margin, "quantity": qty,
                               "fx": fx, "book_source": source, "quote": {"bid": q.bid, "ask": q.ask, "tradable": q.tradable}}
        if fill:
            margin_q = margin / fx
            out.update(avg_price=fill.avg_price, slippage_bps=fill.slippage_bps, levels=fill.levels, notional=fill.avg_price * qty,
                       fee=(fill.avg_price * qty * Decimal(str(cfg["taker_fee"])) * fx).quantize(CENT),
                       liquidation_price=liquidation_price(side, fill.avg_price, qty, margin_q, Decimal(str(cfg["maintenance_margin"]))))
        return out

    async def open(self, user: User, req: OpenRequest) -> tuple[FuturesPosition, dict[str, Any]]:
        acct = await self.trading._account(user, req.account_id, lock=True)
        if req.client_id:
            existing = await self.db.scalar(select(FuturesPosition).where(FuturesPosition.account_id == acct.id,
                                                                          FuturesPosition.client_id == req.client_id))
            if existing:
                return existing, {"idempotent": True}
        cfg = config()
        if req.side not in ("LONG", "SHORT"):
            raise BusinessRuleViolation("side must be LONG or SHORT")
        if not 1 <= req.leverage <= cfg["max_leverage"]:
            raise BusinessRuleViolation(f"leverage must be between 1 and {cfg['max_leverage']}")
        if req.margin.quantize(CENT) != req.margin or req.margin <= 0:
            raise BusinessRuleViolation("margin must be positive with at most 2 decimals")
        inst = await self.instrument(req.symbol)
        try:
            q = await self.market.quote(inst)
        except ProviderUnavailable as e:
            raise BusinessRuleViolation("no market data available") from e

        prof = await self.risk.profile(acct.id, lock=True)
        summary = await self.trading.summary(acct, take_snapshot=False)
        await self.risk.metrics(acct, summary, prof)
        equity, avail = summary["equity"], summary["available_cash"]
        used = Decimal(await self.db.scalar(select(func.coalesce(func.sum(FuturesPosition.margin), 0)).where(
            FuturesPosition.account_id == acct.id, FuturesPosition.status == FuturesStatus.OPEN)))
        open_n = await self.db.scalar(select(func.count()).select_from(FuturesPosition).where(
            FuturesPosition.account_id == acct.id, FuturesPosition.status == FuturesStatus.OPEN)) or 0
        preview = await self.preview(acct, inst.symbol, req.side, req.margin, req.leverage)
        block = await self.risk.block_reason(prof)
        max_one = equity * Decimal(str(cfg["max_margin_pct"])) / 100
        max_all = equity * Decimal(str(cfg["max_total_margin_pct"])) / 100

        def chk(name: str, label: str, ok: bool, value: str, limit: str, msg: str) -> dict:
            return {"name": name, "label": label, "passed": ok, "value": value, "limit": limit, "message": "" if ok else msg}
        checks = [
            chk("trading_allowed", "Trading allowed", block is None, block or "yes", "no halt, kill switch or breaker", block or ""),
            chk("market", "Market open, fresh price", q.tradable, "open" if q.tradable else ("closed" if not q.market_open else "stale"), "tradable",
                "market is closed" if not q.market_open else "quote is stale"),
            chk("minimum", "Minimum margin", req.margin >= MIN_MARGIN, f"{req.margin:,.2f}", f"{MIN_MARGIN:,.2f}", f"margin below the {MIN_MARGIN} minimum"),
            chk("cash", "Available cash", req.margin + (preview.get("fee") or 0) <= avail, f"{avail:,.2f}", f"{req.margin:,.2f} + fee",
                f"insufficient cash: margin {req.margin:,.2f} plus fee, available {avail:,.2f}"),
            chk("margin_pct", "Margin per position", req.margin <= max_one, f"{req.margin:,.2f}", f"{max_one:,.2f} ({cfg['max_margin_pct']:.0f}% of equity)",
                f"margin above {cfg['max_margin_pct']:.0f}% of equity"),
            chk("total_margin", "Total futures margin", used + req.margin <= max_all, f"{used + req.margin:,.2f}",
                f"{max_all:,.2f} ({cfg['max_total_margin_pct']:.0f}% of equity)", f"total futures margin above {cfg['max_total_margin_pct']:.0f}% of equity"),
            chk("open", "Open futures positions", open_n + 1 <= cfg["max_open"], str(open_n + 1), str(cfg["max_open"]), f"at most {cfg['max_open']} open futures positions"),
            chk("size", "Size above the minimum lot", preview["quantity"] > 0, f"{preview['quantity']}", f"{inst.lot_size}", "position is smaller than the minimum size"),
            chk("liquidity", "Order-book liquidity", preview["quantity"] > 0 and "avg_price" in preview, f"{preview.get('levels', 0)} levels",
                "fills within the book", "not enough liquidity on the order book for this size"),
        ]
        reason = next((c["message"] for c in checks if not c["passed"]), None)
        if reason:
            self.db.add(RiskDecision(account_id=acct.id, source="futures", symbol=inst.symbol, side="BUY" if req.side == "LONG" else "SELL",
                                     approved=False, reason=reason, checks=checks))
            await self.db.flush()
            raise FuturesRejected(f"risk: {reason}", checks)

        now = datetime.now(UTC)
        fx, qty, entry = preview["fx"], preview["quantity"], preview["avg_price"]
        fee = preview["fee"]
        margin_q = (req.margin / fx).quantize(MONEY)
        liq = liquidation_price(req.side, entry, qty, margin_q, Decimal(str(cfg["maintenance_margin"])))
        postings = [Posting(LedgerCode.INVESTMENTS, Direction.DEBIT, req.margin), Posting(LedgerCode.CASH, Direction.CREDIT, req.margin)]
        if fee > 0:
            postings += [Posting(LedgerCode.FEES, Direction.DEBIT, fee), Posting(LedgerCode.CASH, Direction.CREDIT, fee)]
        await self.ledger.post(acct, TransactionType.FUTURES_OPEN, postings, created_by=user.id,
                               description=f"Futures {req.side} {inst.symbol} {req.leverage}x, margin {req.margin:,.2f}")
        pos = FuturesPosition(account_id=acct.id, user_id=user.id, symbol=inst.symbol, side=req.side, quantity=qty, entry_price=entry,
                              leverage=req.leverage, margin=req.margin, margin_usd=margin_q, fx_open=fx, liquidation_price=liq, fees=fee,
                              funding=Decimal(0), slippage_bps=preview["slippage_bps"], book_source=preview["book_source"],
                              status=FuturesStatus.OPEN, source=req.source, client_id=req.client_id, opened_at=now, last_funding_at=now)
        self.db.add(pos)
        self.db.add(RiskDecision(account_id=acct.id, source="futures", symbol=inst.symbol, side="BUY" if req.side == "LONG" else "SELL",
                                 approved=True, reason=None, checks=checks))
        await self.db.flush()
        return pos, {"checks": checks, "levels": preview["levels"]}

    async def owned(self, user: User, position_id: uuid.UUID) -> FuturesPosition:
        pos = await self.db.get(FuturesPosition, position_id, with_for_update=True)
        if pos is None or pos.user_id != user.id:
            raise NotFound("Position not found")
        return pos

    async def _settle(self, pos: FuturesPosition, exit_price: Decimal, status: str, fee: Decimal, fx: Decimal, actor) -> None:
        acct = await self.db.get(TradingAccount, pos.account_id)
        if status == FuturesStatus.LIQUIDATED:
            pnl = -pos.margin
        else:
            pnl = ((exit_price - pos.entry_price) * pos.quantity * sign(pos.side) * fx).quantize(MONEY)
            pnl = max(pnl, -pos.margin)                       # isolated margin: you cannot lose more than the margin
        returned = (pos.margin + pnl).quantize(MONEY)
        postings: list[Posting] = []
        if returned > 0:
            postings.append(Posting(LedgerCode.CASH, Direction.DEBIT, returned))
        if pos.margin > 0:
            postings.append(Posting(LedgerCode.INVESTMENTS, Direction.CREDIT, pos.margin))
        if pnl > 0:
            postings.append(Posting(LedgerCode.REALISED_PNL, Direction.CREDIT, pnl))
        elif pnl < 0:
            postings.append(Posting(LedgerCode.REALISED_PNL, Direction.DEBIT, -pnl))
        if fee > 0:
            postings += [Posting(LedgerCode.FEES, Direction.DEBIT, fee), Posting(LedgerCode.CASH, Direction.CREDIT, fee)]
        if postings:
            await self.ledger.post(acct, TransactionType.FUTURES_CLOSE, postings, created_by=actor,
                                   description=f"Futures {status.lower()} {pos.side} {pos.symbol} at {exit_price}")
        pos.status, pos.exit_price, pos.realised_pnl, pos.closed_at = status, exit_price, pnl, datetime.now(UTC)
        pos.fees += fee
        await self.db.flush()

    async def close(self, user: User, position_id: uuid.UUID) -> FuturesPosition:
        pos = await self.owned(user, position_id)
        return await self.close_position(pos, user.id, "manual")

    async def close_position(self, pos: FuturesPosition, actor, reason: str) -> FuturesPosition:
        """Close at market by walking the book (manual close, or the bot's stop-loss / time exit)."""
        if pos.status != FuturesStatus.OPEN:
            raise BusinessRuleViolation("position is already closed")
        acct = await self.db.get(TradingAccount, pos.account_id)
        inst = await self.instrument(pos.symbol)
        fill, _ = await self.quote_fill(inst, "SELL" if pos.side == "LONG" else "BUY", pos.quantity)
        if fill is None:
            raise BusinessRuleViolation("not enough liquidity on the order book to close right now; try again shortly")
        fx = await self._fx(inst, acct)
        fee = (fill.avg_price * pos.quantity * Decimal(str(config()["taker_fee"])) * fx).quantize(CENT)
        pos.exit_reason = reason
        await self._settle(pos, fill.avg_price, FuturesStatus.CLOSED, fee, fx, actor)
        return pos

    async def mark(self, inst: Instrument) -> Decimal | None:
        try:
            q = await self.market.quote(inst)
        except ProviderUnavailable:
            return None
        return None if q.stale else (q.bid + q.ask) / 2

    async def check_liquidations(self) -> int:
        """Worker: liquidate every open position whose mark price crossed its liquidation price."""
        n = 0
        for pos in list(await self.db.scalars(select(FuturesPosition).where(FuturesPosition.status == FuturesStatus.OPEN)
                                              .with_for_update(skip_locked=True))):
            m = await self.mark(await self.instrument(pos.symbol))
            if m is None:
                continue
            if (pos.side == "LONG" and m <= pos.liquidation_price) or (pos.side == "SHORT" and m >= pos.liquidation_price):
                pos.exit_reason = "liquidated"
                await self._settle(pos, pos.liquidation_price, FuturesStatus.LIQUIDATED, Decimal(0), pos.fx_open, None)
                n += 1
        return n

    async def apply_funding(self, now: datetime | None = None) -> int:
        """Worker: at 00:00, 08:00 and 16:00 UTC, move funding between longs and shorts (through margin)."""
        now = now or datetime.now(UTC)
        rate = Decimal(str(config()["funding_rate_8h"]))
        mmr = Decimal(str(config()["maintenance_margin"]))
        n = 0
        for pos in list(await self.db.scalars(select(FuturesPosition).where(FuturesPosition.status == FuturesStatus.OPEN)
                                              .with_for_update(skip_locked=True))):
            due = next_funding(pos.last_funding_at)
            if due > now:
                continue
            periods = 1 + math.floor((now - due).total_seconds() / (FUNDING_HOURS * 3600))
            m = await self.mark(await self.instrument(pos.symbol))
            if m is None:
                continue
            pay_q = m * pos.quantity * rate * periods * sign(pos.side)       # > 0: this position pays
            pay = (pay_q * pos.fx_open).quantize(MONEY)
            pay = min(pay, pos.margin)
            acct = await self.db.get(TradingAccount, pos.account_id)
            if pay > 0:
                postings = [Posting(LedgerCode.REALISED_PNL, Direction.DEBIT, pay), Posting(LedgerCode.INVESTMENTS, Direction.CREDIT, pay)]
            elif pay < 0:
                postings = [Posting(LedgerCode.INVESTMENTS, Direction.DEBIT, -pay), Posting(LedgerCode.REALISED_PNL, Direction.CREDIT, -pay)]
            else:
                postings = []
            if postings:
                await self.ledger.post(acct, TransactionType.FUTURES_FUNDING, postings, created_by=None,
                                       description=f"Funding {pos.side} {pos.symbol} ({periods} period(s))")
            pos.margin -= pay
            pos.margin_usd = (pos.margin / pos.fx_open).quantize(MONEY)
            pos.funding -= pay
            pos.liquidation_price = liquidation_price(pos.side, pos.entry_price, pos.quantity, pos.margin_usd, mmr)
            pos.last_funding_at = due + timedelta(hours=FUNDING_HOURS * (periods - 1))
            n += 1
        await self.db.flush()
        return n

    async def read(self, pos: FuturesPosition, acct: TradingAccount | None = None) -> dict[str, Any]:
        inst = await self.instrument(pos.symbol)
        m = await self.mark(inst) if pos.status == FuturesStatus.OPEN else None
        out = {c: getattr(pos, c) for c in ("id", "account_id", "symbol", "side", "quantity", "entry_price", "leverage", "margin",
                                            "liquidation_price", "fees", "funding", "slippage_bps", "book_source", "status",
                                            "exit_price", "realised_pnl", "source", "opened_at", "closed_at",
                                            "stop_price", "exit_due_at", "exit_reason", "signal")}
        out["price_decimals"] = inst.price_decimals
        out["mark_price"] = m
        if m is not None:
            acct = acct or await self.db.get(TradingAccount, pos.account_id)
            fx = await fx_rate(self.market, inst.quote_currency, acct.base_currency) or pos.fx_open
            upnl = max(((m - pos.entry_price) * pos.quantity * sign(pos.side) * fx).quantize(MONEY), -pos.margin)
            out["unrealised_pnl"] = upnl
            out["roe_pct"] = float(upnl / pos.margin * 100) if pos.margin else 0.0
            out["distance_to_liquidation_pct"] = float(abs(m - pos.liquidation_price) / m * 100)
        return out


async def futures_value(db: AsyncSession, market, acct: TradingAccount) -> tuple[Decimal, Decimal, Decimal]:
    """(margin locked, unrealised P&L, value) of the account's open futures, in the account currency."""
    rows = list(await db.scalars(select(FuturesPosition).where(FuturesPosition.account_id == acct.id,
                                                               FuturesPosition.status == FuturesStatus.OPEN)))
    margin = upnl = Decimal(0)
    for pos in rows:
        margin += pos.margin
        inst = await market.get(pos.symbol)
        try:
            q = await market.quote(inst)
            m = (q.bid + q.ask) / 2
        except ProviderUnavailable:
            continue
        fx = await fx_rate(market, inst.quote_currency, acct.base_currency) or pos.fx_open
        upnl += max((m - pos.entry_price) * pos.quantity * sign(pos.side) * fx, -pos.margin)
    return margin, upnl, margin + upnl
