# AUREX AI — video walkthrough and project description

A two-minute captioned walkthrough of the public demo, recorded with
`frontend/scripts/record-walkthrough.cjs`. The captions on screen are the short narration
below; the longer voice-over text is there if you want to record a spoken version over the
same footage.

Regenerate the video at any time (Chromium and ffmpeg required):

```bash
cd frontend
node scripts/record-walkthrough.cjs https://muhammadhaiderabbas.github.io/AUREX-AI-Foundation/ ./video
ffmpeg -i video/aurex-walkthrough.webm -c:v libx264 -pix_fmt yuv420p -crf 22 -movflags +faststart video/aurex-walkthrough.mp4
```

## Scene by scene (≈ 2 min 05 s, 1280 × 720)

| Time | Scene | On-screen caption | Voice-over (optional, longer) |
|---|---|---|---|
| 0:00 | Title card | Autonomous multi-market research and paper-trading platform | AUREX AI is a research and paper-trading terminal for crypto, forex, stocks and ETFs, with a binary options simulator. Everything you will see uses virtual money. |
| 0:07 | Sign in | One click creates a demo trader with a £100 GBP paper account | The public demo runs entirely in your browser. The full system is a FastAPI and PostgreSQL backend with the same features. Here we start with a realistic £100 account. |
| 0:11 | Overview | The LIVE badge shows the account stream; equity is marked to market every 2 seconds | The header shows the connection to the live account stream. Equity is revalued on live prices every two seconds and the chart extends as you watch. |
| 0:17 | Markets | Session calendars, stale-quote rules; the last candle ticks with every quote | Markets cover four asset classes with real trading-session calendars. The candlestick chart updates its last bar with every quote and keeps your zoom. Indicators such as moving averages and RSI are computed on the server. |
| 0:29 | Paper order | Fractional quantities make a £100 account usable; every order passes the risk gate | We buy 0.0001 bitcoin, about six pounds. Fractional shares and single-unit FX lots make small accounts work. The order passes business checks, then the independent risk gate, then fills on the live ask with spread, slippage and fees. |
| 0:36 | AI Trading | Eight specialist agents report evidence; a consensus engine decides, with NO-TRADE rules | Eight agents — technical, quant, regime, news, sentiment, fundamental, portfolio and risk — each report a score with evidence. The consensus engine weighs them and refuses to trade when coverage or agreement is too low. Proposals still go through the risk gate. |
| 0:47 | AI Research Lab | Hybrid retrieval; verified facts separated from interpretation | Documents are chunked, embedded and indexed for hybrid vector and full-text search. Research reports quote-check every fact against its source, label interpretation separately and surface contradictions. |
| 0:53 | Model Lab | Leak-free features, purged walk-forward validation, nine promotion gates | Models are trained on leak-free features and validated with purged walk-forward splits against baselines after costs. Nine gates, including plausibility and real-data checks, decide whether a human may promote them. |
| 0:58 | Backtesting | Event-driven simulation; optimise in-sample, judge once out-of-sample | The backtester simulates latency, spread, slippage, fees, gaps and the same breakers as live trading. Parameters are tuned in-sample and evaluated once out-of-sample against buy and hold. |
| 1:04 | Binary options | 80% payout: you must win 55.6% to break even. Paper only — banned for UK retail | Binary options are a simulator only; they are banned for retail customers in the UK and restricted in the EU. The page shows the break-even rate and expected value before every contract. |
| 1:09 | Binary · live | The strike is drawn on the live chart; settlement posts to the ledger | Once opened, the strike appears on the live price chart, the countdown runs, the status flips in and out of the money, and settlement is posted to the ledger automatically. |
| 1:18 | Portfolio | Positions at the live bid, binary stakes at risk, live equity curve | Positions are marked to the live bid, open binary stakes count as exposure, and the equity curve keeps growing. |
| 1:25 | Risk Centre | Limits, breakers, binary caps, kill switches, autopilot — every decision recorded | Risk per trade, position size, gross exposure, daily-loss and drawdown breakers, binary stake caps, account and platform kill switches, and the autopilot all live here. Every decision is stored with every check it ran. |
| 1:32 | Trade history and wallet | Every order's timeline; balances from a double-entry ledger | Each order has a full event timeline. The wallet is a double-entry ledger: fills, fees, binary stakes and payouts are all balanced transactions. |
| 1:41 | Analytics | TWR, Sharpe, Sortino, drawdown, execution cost, AI signal quality | Analytics report time-weighted returns, risk-adjusted ratios, drawdowns, execution costs in basis points, risk-gate statistics and the quality of AI signals, with hashed reports and CSV exports. |
| 1:47 | Security and operations | Hash-chained audit trail, 2FA, anchoring, backups, go-live gates | The audit trail is hash-chained and verifiable end to end. There is TOTP two-factor authentication, external audit anchoring, backups with automated restore drills, Prometheus metrics and go-live gates. |
| 1:56 | Closing card | Paper trading only — by design | Live trading is disabled in code; the go-live gates report readiness but switch nothing on. This is not investment advice. |

## The project in one page

**What it is.** AUREX AI is a modular-monolith trading intelligence platform: a FastAPI
backend (async SQLAlchemy, PostgreSQL with pgvector, Redis), a React and TypeScript terminal
(TanStack Query, TradingView Lightweight Charts), and a static GitHub Pages demo that ports the
whole system to the browser. It was built in twelve phases plus two follow-ups:

1. **Foundation** — auth with roles, double-entry virtual ledger, hash-chained audit log, Docker, CI.
2. **Market data** — instrument registry, DST-aware session calendars, synthetic/Coinbase/ECB providers, candles, indicators, WebSocket quotes.
3. **Research engine** — ingestion (text, HTML, PDF, URL, RSS), hybrid retrieval, grounded reports with quote-checked citations.
4. **AI agents** — eight specialists, orchestrator and consensus engine with NO-TRADE rules, sized proposals.
5. **Quant models** — leak-free features, logistic / random forest / LightGBM, purged walk-forward validation, promotion gates, drift monitoring.
6. **Backtesting** — event-driven simulator, four strategies, in-sample optimisation and single out-of-sample evaluation.
7. **Paper execution** — market, limit and stop orders, fills with costs, positions, ledger postings, background matcher.
8. **Risk engine** — pre-trade gate, breakers, kill switches, brackets with OCO, autopilot with emergency stop.
9. **Analytics** — performance, trade, execution, risk and AI-quality analytics; hashed reports and exports.
10. **Security** — threat model, 2FA, key rotation, rate limits, audit export, dependency/SAST/secret/image scanning.
11. **Production** — HTTPS compose stack, leader election, Redis-shared limits, metrics and alerts, backups with restore drills, audit anchoring, go-live gates.
12. **Small accounts and binary options** — fractional lots, minimum order value, £100 presets, binary options simulator with its own risk gate.
13. **Live everywhere** — WebSocket account stream, live candles, live equity, live binary chart.

**Live data flow.** Quotes stream over `/api/v1/markets/stream` every second. The background
worker (one elected leader) matches resting orders, settles binaries and trips breakers every
second. `/api/v1/stream/account` watches database fingerprints and pushes what changed plus a
mark-to-market valuation every two seconds, so fills made by the worker appear on screen without
a refresh.

**Boundaries.** Paper trading only; live trading is hard-disabled. Binary options are a
simulator because they are banned for UK retail customers. Nothing here is investment advice.
