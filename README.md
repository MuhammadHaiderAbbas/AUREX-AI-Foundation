# AUREX AI

Autonomous multi-market research and **paper-trading** platform covering crypto, FX, stocks and ETFs.

> **Stage 1: virtual capital only.** No real money is moved, no broker is connected,
> and live trading is disabled in both the code and the database.

This repository holds **Phase 1: Foundation v1**. It is a modular-monolith backend
(FastAPI), a React terminal UI, a double-entry virtual ledger, authentication with
roles, a tamper-evident audit trail, a Docker stack and CI.

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
| Backend (pytest, real Postgres) | `make backend-test` | 39 tests: auth flows, token rotation/reuse, RBAC, tenant isolation, ledger maths, DB-level invariants, concurrency, idempotency, audit tamper detection, config guards |
| Frontend | `make frontend-build` | strict TypeScript + production build |
| End-to-end (Playwright) | `make e2e` | register → create paper account → deposit/withdraw → session restore → logout; admin audit verification; RBAC in UI |

For the admin e2e test, set `AUREX_E2E_ADMIN_EMAIL` and `AUREX_E2E_ADMIN_PASSWORD`.

## Repository layout

```
backend/          FastAPI app, Alembic migrations, tests
  app/api/        routers (v1), auth dependencies
  app/core/       config, security, errors, middleware, rate limiting
  app/models/     SQLAlchemy models (identity, accounts, ledger, audit)
  app/services/   auth, accounts, ledger, audit
  app/{agents,trading,risk,research,integrations}/   reserved for later phases
frontend/         React + TypeScript + Vite + Tailwind; Caddy image for serving
  src/components/ design system (shadcn-style primitives) and app shell
  src/features/   auth + accounts state
  src/pages/      Overview, Wallet, Settings, Administration, phase placeholders
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

**Next: Phase 2/3.** Design-system expansion and market-data infrastructure: asset
registry, provider adapters, historical OHLCV and streaming.

See `docs/architecture/overview.md` for the architecture and `docs/architecture/decisions.md` for the ADRs.
