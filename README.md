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
| Backend (pytest, real Postgres) | `make backend-test` | 68 tests: auth, token rotation/reuse, RBAC, tenant isolation, ledger maths and DB invariants, concurrency, idempotency, audit tampering, session calendars (DST/holidays), indicators, synthetic determinism, provider adapters (mocked HTTP), staleness, outage handling, watchlists, WebSocket |
| Frontend | `make frontend-build` | strict TypeScript + production build |
| End-to-end (Playwright) | `make e2e` | register → paper account → deposit/withdraw → session restore → logout; admin audit verification; RBAC; live market streaming and charts |
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
  app/{agents,trading,risk,research,integrations}/   reserved for later phases
frontend/         React + TypeScript + Vite + Tailwind; Caddy image for serving
  src/components/ design system (shadcn-style primitives) and app shell
  src/features/   auth + accounts state
  src/pages/      Overview, Markets, Wallet, Settings, Administration, phase placeholders
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

**Next: Phase 4, the financial research engine:** news and filings ingestion, extraction,
RAG with pgvector, and cited research reports.

See `docs/architecture/overview.md` for the architecture and `docs/architecture/decisions.md` for the ADRs.
