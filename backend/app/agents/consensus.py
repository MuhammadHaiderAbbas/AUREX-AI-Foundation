"""Consensus & strategy engine: combines agent evidence into a decision.

Rules (any one forces NO_TRADE, and every reason is reported):
  * directional coverage (sum of weights of agents that did not abstain) < 0.5
  * |net score| < 0.20                       -> signal too weak
  * weighted agreement with the net side < 60% -> agents disagree
  * regime gate closed (extreme volatility or distribution drift)
  * advisory risk pre-check failed
  * net view bearish: short selling is disabled in spot paper trading
The reported confidence is consensus strength x coverage. It is not a calibrated
probability and is labelled as such.
"""

from dataclasses import dataclass, field
from datetime import timedelta
from decimal import Decimal
from typing import Any

from app.agents.base import AgentContext, Finding
from app.agents.specialists import STOP_ATR, TARGET_ATR

DIRECTIONAL_WEIGHTS = {"technical": 0.35, "quant": 0.25, "fundamental": 0.15, "news": 0.15,
                       "sentiment": 0.10}
MIN_COVERAGE, MIN_NET, MIN_AGREEMENT = 0.5, 0.20, 0.6
STRATEGY_ID = "consensus_trend_v1"
PROPOSAL_TTL = timedelta(hours=4)


@dataclass
class Decision:
    decision: str                       # "BUY" | "NO_TRADE"
    net_score: float
    agreement: float
    coverage: float
    confidence: float
    reasons: list[str]
    weights: dict[str, float]
    proposal: dict[str, Any] | None = None
    bias: str = "neutral"
    notes: list[str] = field(default_factory=list)


def decide(ctx: AgentContext, findings: dict[str, Finding],
           weights: dict[str, float] | None = None) -> Decision:
    weights = {k: v for k, v in (weights or DIRECTIONAL_WEIGHTS).items() if k in findings}
    active = {k: f for k, f in findings.items() if k in weights and f.status == "ok"}
    total_w = sum(weights.values()) or 1.0
    coverage = sum(weights[k] for k in active) / total_w
    wc = {k: weights[k] * f.confidence for k, f in active.items()}
    denom = sum(wc.values())
    net = sum(wc[k] * f.score for k, f in active.items()) / denom if denom else 0.0
    side = 1 if net > 0 else -1 if net < 0 else 0
    voting = {k: f for k, f in active.items() if f.direction != 0}
    vote_w = sum(wc[k] for k in voting)
    agreement = (sum(wc[k] for k, f in voting.items() if f.direction == side) / vote_w
                 if vote_w and side else 0.0)
    bias = "bullish" if net >= MIN_NET else "bearish" if net <= -MIN_NET else "neutral"

    reasons: list[str] = []
    if coverage < MIN_COVERAGE:
        reasons.append(f"insufficient agent coverage ({coverage:.0%} of directional weight)")
    if abs(net) < MIN_NET:
        reasons.append(f"signal too weak (net score {net:+.2f}, needs ±{MIN_NET:.2f})")
    if voting and agreement < MIN_AGREEMENT:
        reasons.append(f"agents disagree ({agreement:.0%} weighted agreement)")
    reg = findings.get("regime")
    if reg is None or reg.status != "ok":
        reasons.append("market regime could not be classified")
    else:
        reasons += reg.data.get("gates", [])
    risk = findings.get("risk")
    if risk is not None and not risk.data.get("approved", False):
        reasons += [f"risk pre-check: {r}" for r in risk.data.get("reasons", [])
                    if r not in reasons and f"risk pre-check: {r}" not in reasons
                    and r not in (reg.data.get("gates", []) if reg else [])]
    if bias == "bearish":
        reasons.append("bearish view: short selling is disabled in spot paper trading")

    confidence = round(abs(net) * agreement * coverage, 3)
    d = Decision("NO_TRADE" if reasons or side <= 0 else "BUY", round(net, 3),
                 round(agreement, 3), round(coverage, 3), confidence, reasons, weights, bias=bias)
    if d.decision == "BUY":
        d.proposal = build_proposal(ctx, findings, d)
    return d


def build_proposal(ctx: AgentContext, findings: dict[str, Finding], d: Decision) -> dict[str, Any]:
    pf = findings["portfolio"].data
    tech = findings["technical"].data
    dec = ctx.instrument.price_decimals
    q = Decimal(1).scaleb(-dec)
    entry: Decimal = pf["entry"].quantize(q)
    atr = Decimal(str(tech["atr_1h"]))
    stop = (entry - atr * Decimal(str(STOP_ATR))).quantize(q)
    target = (entry + atr * Decimal(str(TARGET_ATR))).quantize(q)
    invalidation = [
        f"Hourly close below the stop at {stop}",
        "Trend reversal: SMA20 crosses below SMA50 on the hourly chart",
        "Volatility regime moves outside the validated range",
        "Quote becomes stale or the market closes before entry",
    ]
    if findings["news"].status == "ok":
        invalidation.append("A high-impact event enters the 3-day window")
    return {
        "symbol": ctx.instrument.symbol,
        "direction": "BUY",
        "strategy_id": STRATEGY_ID,
        "confidence": d.confidence,
        "entry_type": "LIMIT",
        "entry_price": entry,
        "stop_loss": stop,
        "take_profit": target,
        "quantity": pf["quantity"],
        "notional": pf["notional"].quantize(Decimal("0.01")),
        "risk_amount": pf["risk_amount"].quantize(Decimal("0.01")),
        "reward_risk": round(TARGET_ATR / STOP_ATR, 2),
        "invalidation_conditions": invalidation,
        "risk_check_required": True,
        "expires_at": ctx.now + PROPOSAL_TTL,
    }


