# AI agent department (Phase 5)

```
              ┌──────────────── one immutable AgentContext snapshot ────────────────┐
              │ hourly + daily candles · quote · research docs · paper account · FX │
              └───────────────────────────────┬─────────────────────────────────────┘
   directional votes                          │                         gates
   technical 35% · quant 25% ·                ▼                  regime · portfolio · risk
   fundamental 15% · news 15% ·      Chief orchestrator ──► Consensus & strategy engine
   sentiment 10%                                                      │
                                                     BUY proposal  or  NO TRADE (with reasons)
                                                          │
                                     PENDING_RISK_REVIEW ──► (Phase 9 risk gate, Phase 8 execution)
```

## Agents
| Agent | Input | Output |
|---|---|---|
| Technical | 300 hourly candles | SMA20/50 trend in ATRs, RSI(14), MACD histogram, Bollinger %B, and ATR for stops |
| Quant | Hourly log returns | Drift t-statistic, P(drift > 0), 24h forecast with a 95% interval, mean-reversion distance |
| Fundamental | Earnings and filings tagged to the instrument | Tone of those documents. Abstains for crypto and FX; ratio and valuation analysis comes later |
| News | News and analysis ≤ 7 days old; macro events ≤ 3 days old | Recency-weighted tone and a high-impact-event flag |
| Sentiment | Research ≤ 30 days old | Weighted tone. No positioning feed is connected yet, and the agent says so |
| Regime *(gate)* | Daily and hourly history | Volatility percentile, efficiency ratio, and a **KS concept-drift test** that closes the gate on extreme volatility or a distribution shift |
| Portfolio *(gate)* | Paper account, quote, ATR, FX | Size at **0.5% of equity at risk** (stop = 2 × ATR), no leverage, ≤ 20% of equity and ≤ cash per position, lot-rounded, converted through live FX quotes |
| Risk *(gate)* | All of the above | Advisory pre-check: market open, stale quote, tradable source, spread limit, event window, sizing, max positions. **The independent risk gate (Phase 9) has final authority** |

Agents are pure functions of the snapshot. Each one reports a status (`ok`, `abstain` or
`error`), a direction, a score, its own confidence, a plain-language summary, and evidence
rows. If one agent fails, it is recorded as `error` and the rest of the run continues.

## Decision rules
The net score is the confidence-weighted mean of the directional scores. Any of these
conditions makes the decision **NO TRADE**, and every reason is reported:
- directional coverage below 50%;
- |net score| below 0.20;
- weighted agreement below 60%;
- the regime gate is closed;
- the risk pre-check fails;
- the view is bearish, because short selling is disabled in spot paper trading.

Confidence = |net| × agreement × coverage. It is **uncalibrated** and labelled as such.

## Proposal (blueprint format)
`symbol, direction, strategy_id, confidence, entry_type=LIMIT, entry (ask), stop_loss (−2 ATR),
take_profit (+3 ATR, so reward:risk is 1.5), quantity, notional, risk_amount,
invalidation_conditions, risk_check_required=true, expires_at (4 hours)`.

Database constraints enforce `stop < entry < take_profit`, `quantity > 0` and
`risk_check_required`. The status is `PENDING_RISK_REVIEW` or `DISMISSED`; expiry is reported
on read. Nothing in this phase can move from a proposal to an order. Every run is persisted
(`ai_runs`, `ai_findings`, `trade_proposals`) with its context snapshot, and audited
(`ai.run`).

## Configuration
`ai_agents` holds each agent's weight, enabled flag and version. Admins can change the
weights and enable or disable directional agents (audited). Gates cannot be disabled.
