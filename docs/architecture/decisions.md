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

## ADR-011 Deterministic, explainable agents first
**Decision.** The first agents are transparent statistical and rule-based functions of an
immutable snapshot. LLMs are not in the decision path. Claude is used in research (Phase 4),
where its claims are verified.
**Why.** Every decision must be reproducible from stored inputs and explainable row by row.
A deterministic baseline is also what any future ML or LLM agent must beat after costs and
out of sample (Phase 6–7) before it earns vote weight.

## ADR-012 Proposals are inert by construction
**Decision.** Trade proposals have no execution path in Phase 5. `risk_check_required` is
enforced by a database constraint. Bearish views never become short orders. The advisory
risk agent cannot approve anything; the independent risk gate (Phase 9) has final authority.
**Why.** This follows the blueprint's core rule: the AI never talks to an exchange, and the
risk controller can reject anything, regardless of AI confidence.

## ADR-013 Gated, human promotion of models
**Decision.** Training only ever produces *candidates*. A candidate becomes champion only if
all nine walk-forward gates pass and an administrator promotes it (audited). Drift on a
champion removes its eligibility but never triggers automatic retraining or promotion.
**Why.** This follows the blueprint rule that the AI must never automatically rewrite its own
production trading rules. It keeps a human accountable for every model that can influence
proposals.

## ADR-014 Treat implausible results as failures
**Decision.** Out-of-sample Sharpe above 4 or AUC above 0.75, and any training on synthetic
data, fail validation.
**Why.** Results like these on liquid markets are far likelier to come from look-ahead
leakage or an artificial data source than from a real edge. Our own synthetic generator
produces exactly such results, which is what motivated the gate.

## ADR-015 Pessimistic, event-driven fills
**Decision.** Fills happen at the next bar's open after a configurable latency, never at the
signal bar's close. Stops that are gapped through fill at the open. When stop and target are
both touched within a bar, the stop is assumed to have filled first.
**Why.** Close-to-close backtests that fill on the signal bar silently use information
they couldn't have had, and optimistic intrabar assumptions inflate results. Pessimistic
conventions err toward underestimating performance, which is the safe direction for a
system that will eventually trade real money.

## ADR-016 One-shot out-of-sample evaluation
**Decision.** Parameters are chosen on the in-sample 60% only. The out-of-sample 40% is
evaluated exactly once per backtest, and decay between the two is reported and flagged.
**Why.** Re-optimising until out-of-sample looks good turns it into in-sample data.
Showing the degradation, the parameter surface and the buy & hold benchmark side by side
makes overfitting visible.

## ADR-017 Fill paper orders on the live bid/ask with backtest costs
**Decision.** Paper fills use the live quote's ask (buys) or bid (sells), plus the Phase 7
per-asset-class slippage and commission. Positions are marked at the bid.
**Why.** Mid-price fills make paper trading look better than reality. Using the same cost
model as the backtester keeps backtest, paper and (eventually) live results comparable, and
keeps the gap between them measurable.

## ADR-018 Persist business rejections
**Decision.** An order that is well formed but breaks a rule (no cash, no position, closed
market, position limit, missing FX) is stored as REJECTED with its reason and audited.
Malformed requests are rejected with 422 and not stored.
**Why.** The blueprint requires full provenance for every trading decision. Refused orders
are part of that record and are what the Phase 9 risk engine will add its own rejections to.

## ADR-019 One transaction and an account lock per fill
**Decision.** The execution, ledger transaction, position, order status and snapshot are
written in a single transaction while the trading account row is locked. The matcher uses
`FOR UPDATE SKIP LOCKED`.
**Why.** A fill that is half-written (cash moved but no position) is the worst possible
accounting bug. Locking the account serialises everything that spends its cash, and
SKIP LOCKED makes running the matcher in several processes safe.

## ADR-020 One gate for every order source
**Decision.** Manual tickets, AI proposals, the autopilot and emergency flattening all
submit ordinary orders through the same OMS path, and the risk engine evaluates every one of
them. There is no separate "AI execution" route.
**Why.** The blueprint requires that the AI never trade directly and that the risk engine
have final authority. A single path means there is no way around the gate, and a single
decision log covers everything.

## ADR-021 Halts block exposure, never exits
**Decision.** Kill switches, breakers and the platform halt block orders that increase
exposure. Sells against held positions, including protective stops, are always allowed.
**Why.** A halt that also froze exits would turn a safety control into a source of loss:
positions could not be cut and stops would not fire. Order-rate and price-collar checks still
apply to exits, because they protect against runaway or mistaken orders.

## ADR-022 Breakers on contribution-neutral equity
**Decision.** Daily-loss and drawdown breakers are computed on equity minus net virtual
contributions.
**Why.** Otherwise a withdrawal would look like a loss and trip a breaker, and a deposit
could hide a real drawdown.

## ADR-023 Pessimistic default stop for unprotected entries
**Decision.** An entry without a stop loss is sized for risk as if its stop were a fixed,
fairly wide distance away (crypto 5%, FX 1%, stocks 3%, ETFs 2%).
**Why.** "No stop" must not mean "no risk". The assumption rewards attaching a real
protective stop, which also becomes a working order once the entry fills.

## ADR-024 Time-weighted, flow-neutral returns
**Decision.** Performance uses daily time-weighted returns, with virtual deposits and
withdrawals removed on the day they happen.
**Why.** Money-weighted or raw equity changes would count a deposit as profit and a
withdrawal as loss. Time-weighted returns measure the trading, not the account holder's cash
movements, and are what the industry reports.

## ADR-025 No ratios from short histories
**Decision.** Sharpe, Sortino, volatility, CAGR and Calmar are `null` until there are at
least 20 daily returns, and the UI explains why.
**Why.** An annualised Sharpe from five days is noise presented as precision. Refusing to
compute it is more honest than showing a confident-looking number.

## ADR-026 Evaluate signals, not just trades
**Decision.** AI quality is measured on every agent run, including NO TRADE decisions and
proposals that were never executed, by comparing forward prices, as well as on executed
trades.
**Why.** Judging the agents only on trades that passed the risk gate and were executed is a
selection bias: those trades depend on the gate, the user and luck. Scoring all decisions
against what happened next shows whether the signal itself has an edge.

## ADR-027 Hashed, audited reports
**Decision.** Each full report carries a SHA-256 of its canonical content, and generating or
exporting is written to the audit log with that hash.
**Why.** The blueprint calls for exportable audit reports. A hash lets anyone holding a copy
check that it has not been edited since generation, and the audit entry ties it to who
produced it and when.

## ADR-028 Sign model artifacts with a server-held key
**Decision.** Model artifacts are verified with HMAC-SHA256, using a key that is not stored in
the database, before they are unpickled. Unsigned artifacts are refused until an operator
signs them explicitly.
**Why.** A hash stored next to the artifact only detects accidental corruption: anyone who can
write the row can also write a matching hash. Unpickling attacker-controlled bytes is code
execution, so loading has to require something a database write cannot forge.

## ADR-029 TOTP as the second factor, with encrypted seeds
**Decision.** Two-factor authentication uses RFC 6238 TOTP (authenticator apps) and
single-use recovery codes. Seeds are AES-256-GCM encrypted with a key derived from the
application secret, and decryption also accepts previous secrets.
**Why.** TOTP needs no SMS provider or phone number and works offline. Encrypting the seeds
means a database dump alone cannot mint codes, and accepting previous secrets lets the JWT
secret rotate without locking users out.

## ADR-030 Security limits that fail safe
**Decision.** Rate limits, body limits and lockouts return 413/429 with explicit messages,
health checks are exempt from rate limiting, and exits are never blocked by any of them.
**Why.** Security controls that block legitimate exits or monitoring become availability
incidents themselves. They should refuse the attack, not the operator.

## ADR-031 Scan in CI, not just once
**Decision.** Dependency (pip-audit, npm audit), static (Bandit), secret (detect-secrets) and
image (Trivy) scans run on every PR and weekly, with Dependabot proposing updates.
**Why.** Phase 11's audit found seven published Starlette advisories in a dependency pinned
months earlier. Vulnerability data changes after code is written, so scanning has to be
continuous.

## ADR-032 Leader election with a Postgres advisory lock
**Decision.** Every API replica runs the background worker loop, but only the holder of a
session-level Postgres advisory lock does the work. Each pass writes a heartbeat.
**Why.** It needs no extra infrastructure, since the database is already a hard dependency.
Failover is automatic when the leader's connection closes. It also stops autopilot cycles and
audit anchors from running twice. Readiness and alerts watch the heartbeat.

## ADR-033 Rate limits shared through Redis, failing open
**Decision.** With `AUREX_REDIS_URL` set, all limiters use an atomic Lua sliding window in Redis
(Redis clock); otherwise they run in process. If Redis is unreachable, limits fail open, the
error is counted and alerted on.
**Why.** Per-replica limits multiply with the replica count. Failing closed would turn a cache
outage into a full login outage. The security controls that must never fail open (the risk
gate, kill switches, 2FA) do not depend on Redis.

## ADR-034 External audit anchoring
**Decision.** The worker (and an admin action) periodically writes the audit chain head (the
last record id and its hash) to sinks outside the database: an append-only file on a separate
volume that is synced off-host, and/or an HMAC-signed webhook. Anchors are also kept in an
append-only table.
**Why.** A hash chain inside the database cannot detect a consistent rewrite by someone with
full database access. An anchor held elsewhere turns that into a detectable mismatch
(`audit-verify-anchors`).

## ADR-035 Go-live gates do not switch anything on
**Decision.** The Operations page reports production gates: settings, 2FA, backups, drills,
anchoring, monitoring, shared limits, chain integrity and human attestations. Live trading stays
hard-disabled in code even when every gate is met.
**Why.** Moving real money is a different risk class. It should take a deliberate, reviewed code
change made after the gates are green, not a configuration flag that could be flipped by
accident or by an attacker.

## ADR-036 Small accounts: fractional lots and a minimum order value
**Decision.** Stocks and ETFs trade in 0.0001-share lots and FX in 1-unit lots (migration 0012),
so a £100 account can hold real positions within the 20% position cap. Entry orders below
`AUREX_MIN_ORDER_VALUE` (default 1 in the account currency) are rejected with a reason; exits
are never blocked by it. The account dialog defaults to £100 GBP with presets up to $100,000.
**Why.** Whole shares and 1,000-unit FX lots made a small account unusable without leverage,
which Stage 1 does not allow. The minimum stops dust orders whose fees and rounding dominate.

## ADR-037 Binary options as a paper-only simulator with the house edge on show
**Decision.** Fixed-payout HIGHER/LOWER contracts (default 80% payout; expiries 1 minute to 1
day) are simulated on live mid prices. The stake is posted to INVESTMENTS on open and settled
through REALISED_PNL, so the ledger, equity, breakers and analytics see binaries like any other
exposure. Every contract passes a binary risk gate (halts, kill switch, breakers, order rate,
stake ≤ 2% of equity by default and ≤ 5% ever, at most 3 open, a per-account off switch).
Settlement uses the first fresh quote at or after expiry; with no usable price for 10 minutes
the contract is voided and refunded. There is no autopilot or AI execution for binaries.
**Why.** The user asked for binary trading. Binary options are banned for retail customers in
the UK (FCA, April 2019) and restricted across the EU/EEA because the payout below even money
gives the seller a structural edge: at 80% you must win 55.6% just to break even. A simulator
that shows the break-even rate and the observed edge before and after every contract is useful
for learning that lesson; a real-money version would not be lawful to offer here, and is not
built.
