# Risk engine (Phase 9)

`backend/app/risk/` is the independent risk controller. It sits between every order source
(the order ticket, AI proposals, the autopilot and emergency flattening) and the order book,
and it has the final say. Agents never place orders: a proposal reaches the OMS only through
`execute_proposal`, which submits an ordinary order that faces every check below.

```
manual ticket ─┐
AI proposal ───┼─► OMS shape + business checks ─► RISK GATE ─┬─► approved: fill / rest
autopilot ─────┘   (lot, tick, cash, no shorts)              └─► REJECTED "risk: …" (stored)
                                                     every evaluation ─► risk_decisions (append-only)
background loop ─► re-value accounts ─► breakers trip ─► cancel working buys, pause autopilot ─► risk_events
```

## Pre-trade checks (`engine.py`, pure)

| Check | Default | Ceiling | Applies to |
|---|---|---|---|
| Platform trading halt (admin) | off | — | exposure-increasing orders |
| Account kill switch | off | — | exposure-increasing orders |
| Daily loss breaker | 2% of day-start equity | 5% | exposure-increasing orders |
| Drawdown breaker | 10% from peak | 25% | exposure-increasing orders |
| Order rate (abnormal activity) | 20 per minute | 60 | **every** order; breaching it engages the kill switch |
| Price collar (fat finger) | limit ≤ 5% through the market | 20% | **every** limit order |
| Risk per trade | 0.5% of equity to the stop | 2% | entries |
| Position size | 20% of equity | 50% | entries |
| Gross exposure (incl. working buys) | 50% of equity | 100% | entries |
| Open positions | 5 | 10 | entries |

Risk per trade uses the order's `stop_loss` when it has one. Without one it assumes a
default stop distance per asset class (crypto 5%, FX 1%, stocks 3%, ETFs 2%). That is
conservative on purpose: attaching a real stop lets you trade larger.

**Exits are never blocked by halts or sizing limits.** A SELL against a held position is
always allowed, so positions can be closed and protective stops keep working during a halt.
Exits still face the order-rate and price-collar checks.

Users can tighten limits freely and loosen them only up to the ceilings, which the database
also enforces. Every change is recorded as a risk event (marking which limits were loosened)
and audited.

## Breakers and trading equity

Breakers are measured on **trading equity**, which is equity minus net virtual
contributions. Deposits and withdrawals of virtual cash can therefore neither trip a breaker
nor hide a loss.

- **Daily loss:** loss since the first valuation of the UTC day, as a % of that day's
  starting equity. It resets automatically at 00:00 UTC.
- **Drawdown:** fall from the trading-equity high-water mark. It stays tripped, even if
  prices recover, until the user resets it. A reset re-bases the peak and is audited.
- **Kill switch:** manual, or automatic on abnormal order rates. Released by the user.
- **Platform halt:** set by an admin and applies to every account.

When any of these trips or engages, working BUY orders are cancelled and a running
autopilot is paused. Valuations happen on every order, every fill, every Risk Centre or
portfolio view, and in the background loop for every account with open positions. A
breaker can therefore trip between orders.

## Brackets (protective orders)

An entry order may carry `stop_loss` and/or `take_profit`. Once it fills, the OMS places
protective SELL orders (`source = "protective"`): a STOP and/or a LIMIT. When both exist they
share an `oco_group`, so a fill on one cancels the other.

Protective orders don't count as "pending sells", so you can still sell manually. After a
manual sell they are resized down to the remaining position, and cancelled once the position
is closed.

## AI proposals and the autopilot

`POST /ai/proposals/{id}/execute` turns a pending proposal into a MARKET buy with the
proposal's stop loss and take profit as a bracket. The proposal becomes `EXECUTED`, or
`RISK_REJECTED` with the gate's reason. The client order ID is derived from the proposal,
so it can never execute twice.

Autopilot is configured per account with up to 5 instruments and is STOPPED, RUNNING or
PAUSED. While running, the background loop runs a cycle every
`AUREX_AUTOPILOT_INTERVAL_SECONDS` (default 900); `POST /risk/accounts/{id}/autopilot/run`
runs one now. A cycle:
1. skips instruments that are already held or have a working buy;
2. runs the agent department on each remaining instrument;
3. executes any BUY proposal through the gate.

Cycles are skipped while anything blocks new exposure, and the autopilot cannot be started
then either.

**Emergency stop** stops the autopilot, engages the kill switch and cancels working entry
orders. Protective stops stay in place unless `flatten` is requested, in which case every
position is sold at market.

## Evidence

- `risk_decisions` (append-only): every evaluation, approved or not, with each check's value
  and limit, linked to the order and proposal.
- `risk_events` (append-only): breaker trips, kill-switch changes, limit changes, autopilot
  starts, stops and cycles, emergency stops and platform halts.
- Audit log: `risk.*`, `ai.proposal.execute` and `order.submit` (which now includes bracket
  prices).
