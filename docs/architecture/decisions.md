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

## ADR-007 Market-data provider abstraction and honest labelling
**Decision.** All sources implement one `MarketDataProvider` interface. Synthetic data is
the default and is always labelled `source="synthetic"`. Provider failures surface as
`503` rather than a silent fallback. ECB reference rates are explicitly non-tradable.
**Why.** Paper-trading results are only meaningful if the price source is known. A silent
substitution would contaminate backtests and paper performance. Stocks and ETFs stay
synthetic until a properly licensed feed is chosen (a licensing and cost decision).

## ADR-008 Static public demo on GitHub Pages
**Decision.** The Pages build (`VITE_DEMO_MODE=true`) swaps the HTTP transport for an
in-browser implementation of the same REST contract (`frontend/src/services/demo`),
persisted in `localStorage`, with the synthetic market model ported bit-for-bit.
**Why.** Pages can host only static files. This keeps one UI codebase, needs no hosted
backend or secrets, and holds no user data server-side. **Limits.** It is not a security
boundary, and its business rules duplicate the backend's (kept aligned by the demo e2e
test). The production deployment remains Docker + FastAPI.

## ADR-009 Grounded research: verify, don't trust
**Decision.** Engines (including Claude) only *propose* claims. Each claim must carry source
ids and a verbatim quote, and the server keeps a claim only if the normalised quote appears
in the cited chunk. Confidence is computed from evidence properties and labelled
uncalibrated. Interpretation is always labelled with its basis.
**Why.** LLM summaries of financial documents can sound authoritative while being wrong.
Checking quotes mechanically gives a hard guarantee that every displayed fact exists in a
source. It doesn't guarantee the source is right, which is why provenance and staleness are
shown alongside each fact.

## ADR-010 Local hashing embeddings as the baseline
**Decision.** Start with a deterministic feature-hashing embedder (384 dimensions, stemmed
unigrams and bigrams), stored in pgvector and fused with Postgres full text.
**Why.** It needs no model download or API key, behaves identically in CI and in the
browser demo, and is an honest lexical baseline. Every chunk records its `embedding_model`,
so a semantic model (hosted or local) can be added and the corpus re-indexed, with retrieval
quality measured against this baseline before switching (Phase 6 evaluation tooling).
