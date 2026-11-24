# AUREX AI

Autonomous multi-market research and **paper-trading** platform covering crypto, FX, stocks and ETFs.

> **Stage 1: virtual capital only.** No real money is moved, no broker is connected,
> and live trading is disabled in both the code and the database.

**Live demo:** https://muhammadhaiderabbas.github.io/AUREX-AI-Foundation/ (click **Launch demo**).
The demo is a static build that runs entirely in your browser with simulated data
(see ADR-008). The real system runs the FastAPI backend below.

Delivered so far:
- **Phase 1, Foundation:** FastAPI modular monolith, React terminal UI, double-entry
  virtual ledger, auth with roles, a tamper-evident audit trail, Docker and CI.
- **Phase 3, Market data:** instrument registry for crypto, FX, stocks and ETFs; DST-aware
  session calendars; a provider interface (synthetic, Coinbase, ECB); stored candles;
  indicators; stale and tradable quote rules; watchlists; WebSocket streaming; candlestick
  charts.
- **Phase 4, Research engine:** document ingestion (text, HTML, PDF, URL, RSS);
  classification and instrument tagging; pgvector + full-text hybrid retrieval; grounded
  research reports with quote-checked citations, labelled interpretation, contradictions,
  staleness and heuristic confidence; offline engine plus an optional Claude engine.
- **Phase 5, AI agent department:** technical, quant, fundamental, news, sentiment, regime,
  portfolio and risk agents; an orchestrator and consensus engine with explicit NO TRADE
  rules; sized trade proposals that await the independent risk gate.
- **Phase 6, Quantitative models:** leak-free features; logistic, random forest and LightGBM
  models; purged walk-forward validation against baselines after costs; nine promotion gates
  (including plausibility and real-data checks); a model registry with human promotion; PSI
  drift monitoring; and an ML agent.
- **Phase 7, Strategy and backtesting:** an event-driven simulator (latency fills, spread,
  slippage, fees, gap-aware stops, market closures, daily-loss and drawdown breakers); SMA,
  RSI, Donchian and agent-consensus strategies; in-sample optimisation with a single
  out-of-sample evaluation against buy & hold.
- **Phase 8, Paper execution:** an order management system (market, limit and stop orders,
  GTC/DAY, idempotent client IDs), fills on the live bid/ask with spread, slippage and fees,
  average-cost positions, balanced ledger postings for trades, fees and realised P&L, a
  background order matcher, and a marked-to-market portfolio with equity history.
- **Phase 9, Risk engine:** an independent pre-trade gate for every order (risk per trade,
  position size, gross exposure, open positions, order-rate and price-collar checks);
  daily-loss and drawdown breakers on contribution-neutral equity; account and platform kill
  switches; bracket orders with one-cancels-other; AI proposals executed only through the
  gate; an autopilot with an emergency stop; and append-only decision and event logs.

## Quick start (Docker)

```bash
cp .env.example .env             # set AUREX_JWT_SECRET
docker compose up -d --build     # → http://localhost:8080
docker compose exec backend python -m app.cli create-admin --email you@example.com --name "Your Name"
```

API docs: http://localhost:8080/api/v1/docs

## Native development

Requirements: Python 3.12+, Node 22, PostgreSQL 16.

```bash
./scripts/setup-local-postgres.sh          # creates aurex + aurex_test
make backend-install migrate
make backend-dev                           # API on :8000
make frontend-install frontend-dev         # UI on :5173 (proxies /api → :8000)
```

Instead of Postgres installed locally, you can run `docker compose up -d db redis`.

## Tests

| Suite | Command | Coverage |
|---|---|---|
| Backend (pytest, real Postgres + pgvector) | `make backend-test` | 163 tests: auth, token rotation/reuse, RBAC, tenant isolation, ledger maths and DB invariants, concurrency, idempotency, audit tampering, session calendars (DST/holidays), indicators, synthetic determinism, provider adapters (mocked HTTP), staleness, outage handling, watchlists, WebSocket, research extraction (HTML/PDF/RSS/XXE), retrieval, quote verification, Claude-engine validation and fallbacks, agents (trend/flat/bear, gates, drift, disagreement, sizing, FX, failure isolation), proposals, ML (no look-ahead, purge, metrics, gates, PSI, registry lifecycle, drift, artifact integrity), backtesting (fill timing, costs, gaps, closures, sizing, breakers, causality, IS-only optimisation), paper execution (fill maths, ledger postings, realised P&L, FX conversion, limit/stop matching, expiry, cancel, idempotency, rejections, privacy, append-only executions, DB constraints), risk engine (every check and its boundary, exits through halts, breakers incl. deposits/withdrawals, kill switches, abnormal activity, platform halt, brackets/OCO/resizing, proposal execution and refusal, autopilot, emergency stop) |
| Frontend | `make frontend-build` | strict TypeScript + production build |
| End-to-end (Playwright) | `make e2e` | register → paper account → deposit/withdraw → session restore → logout; admin audit verification; RBAC; live market streaming and charts; research corpus and grounded reports; agent desk; model lab; backtesting; paper trading (market buy, resting limit, rejection, cancel, close position, history, ledger); risk centre (limit change, rejection with checks, bracket order, kill switch, autopilot cycle, emergency stop; platform halt in the demo) |
| Static demo | `npm run build:demo` then `AUREX_E2E_DEMO=1 AUREX_WEB_URL=… npx playwright test e2e/demo.spec.ts` | the GitHub Pages build, served under its sub-path |

For the admin e2e test, set `AUREX_E2E_ADMIN_EMAIL` and `AUREX_E2E_ADMIN_PASSWORD`.

## Repository layout

```
backend/          FastAPI app, Alembic migrations, tests
  app/api/        routers (v1), auth dependencies
  app/core/       config, security, errors, middleware, rate limiting
  app/models/     SQLAlchemy models (identity, accounts, ledger, audit)
  app/services/   auth, accounts, ledger, audit
  app/market/     calendars, providers, indicators, market service (Phase 3)
  app/research/   extraction, chunking, embeddings, retrieval, reports, Claude engine (Phase 4)
  app/agents/     specialists, consensus, orchestrator (Phase 5)
  app/ml/         features, models, walk-forward validation, drift, registry (Phase 6)
  app/backtest/   event-driven engine, strategies, IS/OOS evaluation (Phase 7)
  app/trading/    order management, execution model, positions, portfolio (Phase 8)
  app/risk/       pre-trade engine, breakers, kill switches, autopilot (Phase 9)
  app/integrations/   reserved for later phases
frontend/         React + TypeScript + Vite + Tailwind; Caddy image for serving
  src/components/ design system (shadcn-style primitives) and app shell
  src/features/   auth + accounts state
  src/pages/      Overview, Markets, Portfolio, Trade History, Wallet, labs, Settings, Administration
  src/charts/     candlestick chart (TradingView Lightweight Charts)
  src/services/demo/  in-browser API used only by the GitHub Pages demo build
  e2e/            Playwright specs
docs/             architecture, ADRs, data model, API, security, compliance
infrastructure/   monitoring and deployment (populated in Phase 11)
```

## Phase 1 deliverables

- [x] Repository, Docker development environment, CI
- [x] FastAPI backend with versioned API and OpenAPI docs
- [x] PostgreSQL with Alembic migrations (including integrity triggers)
- [x] Secure registration and login (Argon2id, rotating refresh tokens, rate limiting)
- [x] Administrator and user roles; admin user management
- [x] React terminal UI: dashboard, sidebar navigation, wallet, settings, admin
- [x] Paper account creation with a virtual starting balance
- [x] Double-entry ledger; virtual deposits and withdrawals
- [x] Hash-chained audit logging with verification
- [x] Automated backend, build and end-to-end tests

## Phase 3 deliverables

- [x] Asset and instrument registry (cash instruments only: spot, spot FX, shares, ETFs)
- [x] Market session calendars (24/7, 24/5, NYSE, LSE; DST and holidays)
- [x] Provider interface: synthetic (default), Coinbase (crypto), ECB reference (FX)
- [x] Candle storage with gap-fill and admin backfill; 1m–1d timeframes
- [x] Indicators: SMA, EMA, RSI, Bollinger Bands, MACD
- [x] Stale-data protection and `tradable` flag for the future risk gate
- [x] Watchlists and WebSocket quote streaming
- [x] Markets screen with candlestick charts; public GitHub Pages demo

Market data runs in `synthetic` mode by default. Set `AUREX_MARKET_DATA_MODE=live` for
Coinbase and ECB data (the server needs outbound access to those hosts).

## Phase 4 deliverables

- [x] Ingestion of pasted text and HTML, uploads (PDF, HTML, text), and allow-listed URLs and RSS/Atom feeds
- [x] Extraction with page and paragraph references; deduplication by content hash
- [x] Document classification, instrument tagging and lexical tone
- [x] Chunking and embeddings in pgvector (HNSW) plus Postgres full text, fused with RRF
- [x] Grounded reports: quote-checked facts, labelled interpretation, contradictions, staleness, heuristic confidence
- [x] Offline extractive engine (default) and a Claude engine (`claude-opus-5-5`) with automatic fallback
- [x] Research Lab UI (ask, report view with citations, corpus management, search); works in the static demo

Set `AUREX_RESEARCH_ENGINE=claude` and provide `ANTHROPIC_API_KEY` to use Claude.

## Phase 5 deliverables

- [x] Eight specialist agents with evidence, uncertainty and abstention
- [x] Regime gate with a volatility percentile and a KS concept-drift test
- [x] Portfolio sizing at 0.5% risk of equity, no leverage, exposure caps and FX conversion
- [x] Advisory risk pre-check (market state, staleness, spread, events, limits)
- [x] Consensus engine that defaults to NO TRADE and explains every reason
- [x] Trade proposals in the blueprint format, inert by database constraint, with expiry and dismissal
- [x] Agent registry with admin weights and toggles; runs persisted and audited
- [x] Agent desk UI (decision, agent cards, evidence, proposal, activity timeline); works in the static demo

## Phase 6 deliverables

- [x] Leak-free feature pipeline (tested) and forward-return labels
- [x] Logistic regression, random forest and LightGBM, conservatively regularised
- [x] Purged walk-forward validation with costs, against buy & hold, momentum and climatology
- [x] Nine promotion gates, including plausibility and real-data checks
- [x] Model registry: candidate, champion (human, audited) and retired; one champion per instrument
- [x] Drift monitoring (PSI and calibration decay) that revokes eligibility, never auto-retrains
- [x] Integrity-checked artifacts; ML agent with zero default vote weight
- [x] Model Lab UI (train, gates, equity curves, calibration, importance, folds, drift); logistic regression in the static demo

## Phase 7 deliverables

- [x] Event-driven engine: next-open fills after latency, spread, volatility-scaled slippage, fees
- [x] Gap-aware stops, pessimistic stop-vs-target ordering, session closures
- [x] Blueprint risk limits inside the backtest: 0.5% risk per trade, 20% position cap, no leverage, 2% daily loss halt, 10% drawdown breaker
- [x] Four strategies, including a replay of the Phase 5 agent consensus; causal signals (tested)
- [x] In-sample grid optimisation, one-shot out-of-sample evaluation, fully invested buy & hold benchmark, overfitting warnings
- [x] Backtest Lab UI (equity and drawdown with OOS marker, IS/OOS table, sensitivity grid, trades, risk events); works in the static demo

## Phase 8 deliverables

- [x] Order management: MARKET, LIMIT and STOP orders; GTC (30 days) and DAY; idempotent `client_order_id`; cancel; expiry
- [x] Execution model on the live bid/ask with the Phase 7 slippage and fee schedule; FX conversion to the account currency
- [x] Spot-only, no-leverage rules: no short sells, buying power net of open buy orders, maximum 5 open positions, closed-market and stale-quote rejections
- [x] Rejected orders stored with their reason; submissions and cancels audited
- [x] One atomic transaction per fill: append-only execution and order events, balanced ledger posting (trade, fee, realised P&L), average-cost position, snapshot
- [x] Background matcher (`FOR UPDATE SKIP LOCKED`) plus an admin trigger
- [x] Portfolio (KPIs, positions marked at the bid, allocation, equity history, closed positions), Trade History (orders, timeline, executions) and an order ticket on Markets; all work in the static demo

## Phase 9 deliverables

- [x] Pure pre-trade engine with final authority over every order source: risk per trade (actual or default stop), position size, gross exposure incl. working buys, open positions, order rate, price collar
- [x] Per-account limits with blueprint defaults, user tightening and capped loosening (DB-enforced ceilings), audited
- [x] Daily-loss (auto-reset at 00:00 UTC) and drawdown (manual reset) breakers on contribution-neutral equity, valued on every order, fill, view and background pass
- [x] Account kill switch (manual or automatic on abnormal activity) and admin platform halt; halts block exposure but never exits
- [x] Bracket orders: protective stop and take-profit placed on fill, one-cancels-other, resized or cancelled as the position shrinks
- [x] AI proposals executable only through the gate (`EXECUTED` / `RISK_REJECTED`); autopilot with start, pause, stop, scheduled cycles and an emergency stop (optional flatten)
- [x] Append-only `risk_decisions` and `risk_events`; Risk Centre UI (status, limit meters, controls, limits editor, decision log with every check, events), autopilot on the agent desk, risk checks in the order ticket and trade history; all of it works in the static demo

**Next: Phase 10, analytics:** performance attribution (equity curve, drawdown, Sharpe,
Sortino, profit factor, turnover), execution-quality reports, model calibration and drift
response over live paper results, and exportable audit reports.

See `docs/architecture/overview.md` for the architecture and `docs/architecture/decisions.md` for the ADRs.
