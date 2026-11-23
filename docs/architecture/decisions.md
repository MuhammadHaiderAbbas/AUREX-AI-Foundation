# Architecture decision records

## ADR-001 Modular monolith
**Decision.** Single FastAPI service with module boundaries (`services/`, `trading/`,
`risk/`, `agents/`, …). **Why.** A solo/small team cannot operate 20 services;
in-process calls keep transactions simple (ledger + audit + domain write commit
atomically). **Revisit when** market-data ingestion or model inference needs
independent scaling — those are the first extraction candidates.

## ADR-002 Double-entry ledger with database-enforced invariants
**Decision.** `ledger_transactions` + `ledger_entries` (DEBIT/CREDIT, `NUMERIC(28,8)`).
Postgres enforces: positive amounts; a **deferred constraint trigger** rejecting any
transaction whose debits ≠ credits or that mixes currencies at COMMIT; and
**append-only triggers** blocking UPDATE/DELETE. Corrections are reversing entries.
**Why.** The application can have bugs; the database is the last line of defence
for money invariants. Balances are computed, so they cannot drift from the journal.

## ADR-003 Concurrency and idempotency for cash movements
**Decision.** Movements lock the `trading_accounts` row (`SELECT … FOR UPDATE`) before
checking available cash. Clients send an `Idempotency-Key`; a replay with the same
key returns the original transaction (`200`, `Idempotent-Replay: true`), a mismatched
replay returns `409`. **Why.** Prevents overdraws under concurrency (tested with
six parallel withdrawals) and double-posting on network retries. The same pattern
will be used for order submission in Phase 8.

## ADR-004 Authentication
**Decision.** Short-lived (15 min) HS256 access JWT held **in memory** by the SPA;
opaque refresh token in an `httpOnly; SameSite=Strict` cookie scoped to
`/api/v1/auth`, stored server-side only as SHA-256. Refresh tokens rotate on every
use; replaying a rotated token revokes the entire session family (theft detection).
Every request checks the session row so revocation is immediate. Passwords use
Argon2id. **Next (Phase 11):** TOTP MFA, Redis-backed rate limiting, asymmetric
signing keys with rotation.

## ADR-005 Hash-chained audit log
**Decision.** Each audit row stores `prev_hash` and
`hash = SHA-256(prev_hash ‖ canonical_json(record))`. Appends are serialised with a
transaction-scoped advisory lock. UPDATE/DELETE are blocked by trigger; even a
superuser who bypasses the trigger is detected by `GET /admin/audit/verify`.
**Next:** periodically anchor the head hash outside the database (object storage
with object-lock) so wholesale chain rewrites are also detectable.

## ADR-006 Same-origin deployment
**Decision.** Caddy serves the SPA and proxies `/api` on the same origin. **Why.**
The refresh cookie never crosses origins, CORS is unnecessary in production, and a
strict CSP (`default-src 'self'`) is possible.
