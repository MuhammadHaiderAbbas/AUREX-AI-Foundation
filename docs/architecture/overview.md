# Architecture overview

AUREX AI is a **modular monolith**: one deployable FastAPI service with hard internal
boundaries, a React SPA, PostgreSQL as the system of record, and Redis for real-time
state (from Phase 3). Modules are extracted into services only when load demands it.

```
Browser ──► Caddy (TLS, CSP, static SPA) ──► FastAPI /api/v1
                                               │
          ┌────────────────────────────────────┼─────────────────────────────┐
          │ api/        routers, auth deps, error envelope                    │
          │ services/   auth · accounts · ledger · audit   (Phase 1)          │
          │ integrations/  market-data & broker adapters    (Phase 3)         │
          │ research/   ingestion, RAG, reports              (Phase 4)        │
          │ agents/     orchestrator + specialist agents     (Phase 5)        │
          │ trading/    OMS + paper execution                (Phase 8)        │
          │ risk/       independent risk gate, kill switch   (Phase 9)        │
          └────────────────────────────────────┬─────────────────────────────┘
                                               ▼
                              PostgreSQL (+pgvector) · Redis · object storage
```

## Non-negotiable rules

1. **AI never holds broker credentials.** Agents emit *proposals*. Only `trading/`
   talks to adapters, and only after `risk/` approves. The risk gate can reject any
   order and halt all trading regardless of model confidence.
2. **Money is a ledger, not a number.** Balances are derived from immutable,
   balanced double-entry postings (see `data-model.md`). Nothing stores a balance.
3. **Paper first.** `trading_accounts.mode` is constrained to `PAPER` by the
   database; `live_trading_enabled` is hard-wired `False` in code.
4. **Everything consequential is audited** in a hash-chained, append-only log, in
   the same database transaction as the action itself.
5. **No self-modifying production logic.** Models are proposed and validated;
   promotion is a controlled, audited step (Phase 6).

## Request lifecycle

1. `RequestContextMiddleware` assigns/sanitises `X-Request-ID`, adds security headers.
2. `get_principal` validates the JWT **and** checks the backing session row, so
   logout / disable / password change revoke access immediately (not at token expiry).
3. The route calls a service; the service writes domain rows + ledger postings +
   audit record in one transaction; the route commits.
4. Errors are rendered as `{"error": {code, message, details, request_id}}`.

## Phase 1 scope (this release)

Implemented: identity & roles, sessions, user settings, paper trading accounts,
double-entry virtual ledger, virtual deposits/withdrawals with idempotency, audit
trail with tamper verification, admin user management, API docs, Docker stack, CI.

The remaining blueprint tables (`instruments`, `orders`, `positions`, `ai_runs`,
`model_versions`, `risk_events`, …) are added by the migrations of the phase that
first needs them, so the schema never contains unused, untested tables.
