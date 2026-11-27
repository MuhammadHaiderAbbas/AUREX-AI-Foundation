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

## ADR-038 Live account stream from database fingerprints
**Decision.** `/api/v1/stream/account` is a WebSocket (same in-band token auth as the quote
stream). Every second it compares, per owned account, a cheap fingerprint (row counts and
latest update times of orders, executions, ledger transactions, positions, binary contracts and
risk state) and pushes the topics that changed; every two seconds it pushes a mark-to-market
valuation. The browser invalidates exactly the affected queries, merges valuations into the
cached portfolio, appends them to the equity chart, and ticks the last candle of the price chart
from the quote stream. The order matcher and quote stream now run every second. Without a
socket (and in the static demo) the client polls every two seconds.
**Why.** Fills, settlements and breaker trips happen in the background worker, possibly on
another replica. Fingerprints see them with no pub/sub infrastructure and cannot miss an event
the way a dropped message can; the cost is one small indexed query per connected user per
second. Model Lab and backtest charts stay as they are: they show the results of finished runs,
not live state.

## ADR-039 The binary bot trades only on a validated out-of-sample edge
**Decision.** A one-button bot per paper account. Each minute, for each instrument, it fits a
logistic model on bars matching the contract expiry (1m to 1h), measures its hit rate on the
latest 30% of bars it did not train on (purged), counting only predictions confident enough to
trade, and opens a contract only if that hit rate beats break-even (55.6% at 80% payout) plus a
margin and the current prediction is that confident. Contracts pass the normal binary risk gate.
An edge guard pauses the bot when its live win rate is below break-even after 20 settled
contracts; breakers, kill switches, halts and the binary switch pause it; the emergency stop
stops it. Every cycle's reasoning is stored and shown.
**Why.** The user asked for automatic binary trading. A bot that bets every minute would lose
the house edge by construction. Requiring measured evidence, and stopping on live evidence of
no edge, is the most honest automation possible. This revises ADR-037 ("no autopilot for
binaries"): the bot is paper-only and, like everything else, cannot reach real money.

## ADR-040 Real crypto prices in the public demo; continuous simulated prices elsewhere
**Decision.** The static demo streams BTC, ETH and SOL from Coinbase's public, keyless,
CORS-enabled endpoints: a WebSocket ticker for every trade and REST candles for history. Quotes,
charts, fills, binary strikes and settlement, the AI desk, the binary bot, Model Lab and
backtests use them, and say so ("source Coinbase", "Crypto live · others simulated"). If
Coinbase is unreachable the demo falls back to the synthetic generator. Forex, stocks and ETFs
stay simulated because real-time feeds for them need a keyed, usually paid, vendor whose key
cannot be shipped in a public static site. The synthetic model (browser and Python) now
interpolates its minute noise and adds 5-second noise, so simulated prices move continuously
instead of drawing straight lines with a step every minute. Live charts rebuild from a tick
history endpoint when a tab regains focus, and draw a break rather than a straight line across
time without data.
**Why.** The user saw charts go flat. The cause was the synthetic model, not the streaming.
Real prices where they are free, and honest labels where they are not, fix the problem without
exposing credentials.

## ADR-041 Free real data first, keyed vendors for the rest
**Decision.** Everything that has a free, keyless, browser-accessible source now uses it:
twelve crypto markets (BTC, ETH, SOL, XRP, DOGE, ADA, AVAX, LINK, BCH, LTC, DOT, and PAX Gold
as a gold proxy) stream from Coinbase; forex rates come from Coinbase's exchange-rates API
(refreshed about once a minute) with ECB daily history from Frankfurter; the Markets page adds a
CoinGecko market overview (total capitalisation, volume, dominance, top 20 with 7-day lines).
Coinbase REST calls from the browser are queued (3 at a time, 120 ms apart) with back-off on
HTTP 429. Intraday forex candles remain simulated but are scaled onto the live rate and labelled.
Stocks, ETFs, indices and other commodities stay simulated until a keyed vendor is connected.
**Why.** Real-time equity and index data is licensed: every provider needs a key, and a key
shipped inside a public static site can be copied by anyone. That feed belongs in the backend
of a real deployment, where the key is a server-side secret.

## ADR-042 Real US stocks through Alpaca on the server; Postgres can run on the same host
**Decision.** US stocks and ETFs (now including TSLA, NFLX, DIA, GLD for gold and USO for oil)
use the Alpaca market-data API when a key is present (`AUREX_ALPACA_KEY_ID_FILE`,
`AUREX_ALPACA_SECRET_KEY_FILE`); without one they stay on the simulator, so nothing breaks before
the key is added. The free IEX feed is real time and includes bar history. The production stack
gains an optional `local-db` profile (pgvector Postgres on the same server) and
`make-secrets.sh --local-db`, so a single inexpensive server is enough to start.
**Why.** The user chose to run their own server. Alpaca's free plan covers the instruments in
their watchlist with real-time prices and history, keeps the key server-side, and needs no
payment. UK listings and index levels need a paid feed and remain simulated (labelled).

## ADR-043 30-second binary expiry from recorded live bars; bot cycles scale with expiry
**Decision.** Binary contracts and the bot gain a 30-second expiry (with a `30s` timeframe), and
the bot now defaults to 1 minute. Coinbase has no 30-second candles and its trade history is too
dense to backfill (BTC-USD prints about 1,000 trades every 20 seconds), so the worker leader keeps
one WebSocket open to Coinbase's public ticker channel and records 30-second OHLC bars into
`market_candles` (`app/market/tickbars.py`, source `coinbase_ws`). The demo does the same in the
browser from the stream it already has and saves the bars locally. The first bucket after
connecting is partial and is dropped. A gap (restart, dropped connection, closed page) breaks the
series, and the bot uses only the newest unbroken run. Until 280 bars exist (80 warm-up + 200
usable, about 2 h 20 min) the bot reports "collecting live 30-second bars" instead of trading.
Simulated instruments generate 30-second bars directly. Bots cycle every
`min(60 s, max(10 s, expiry / 3))`, so 30-second contracts are checked every 10 seconds.
**Why.** The user asked for shorter expiries. Padding real crypto history with simulated bars
would let the bot "validate" an edge on data that never happened, so it waits for real bars.
Shorter expiries are noisier: the same out-of-sample gate (hit rate above 55.6% plus a margin)
still decides whether any contract is opened.

## ADR-044 Live-mode hardening: forex rates, quotes from the feed, empty-history guard
**Decision.** A local end-to-end run in live mode, which CI does not cover because it uses
simulated prices, found three problems that are now fixed:
- **Forex was never tradable on the server.** Only ECB daily fixings were available. FX now
  uses `LiveFxProvider`: Coinbase's public exchange-rates API (one cached request serves every
  pair) for quotes with a small spread, ECB history for `1d`, and simulated intraday candles
  scaled to the live rate, stored with `source: synthetic` and labelled.
- **Position revaluation polled Coinbase REST every second per instrument** (ticker and
  stats). With a dozen coins held, that is over the public limit of about 10 requests per
  second. Quotes are now read from the ticker WebSocket the worker leader already keeps open;
  REST is the fallback when a product has been quiet for 30 s, and 24 h stats are cached for
  a minute.
- **The bot signal crashed (HTTP 500) with no bars**, which is the state right after the
  server starts recording 30-second bars. It now returns "not enough history".
**Why.** These only show up against real upstreams. The same run checked all 12 coins and 3
FX pairs live and tradable, a 30-second contract settling on the live price, an FX market
order filling, and the bot declining on real 1-minute data with no validated edge.

## ADR-045 Remove the 30-second binary expiry (supersedes the 30-second part of ADR-043)
**Decision.** The shortest binary expiry is 1 minute again, for manual contracts and the bot. The
30-second timeframe, the server's 30-second bar recording and the browser's 30-second bar builder
are removed. Migration 0017 moves bots set to 30 seconds to 1 minute and deletes recorded
30-second bars. The live Coinbase ticker connection stays, because it supplies server-side quotes
(ADR-044).
**Why.** 30-second moves are mostly noise, so the model has little to learn. They also needed
about 2 h 20 min of recording before the bot could judge an edge, and they encourage over-trading.
The product owner asked for 1 minute as the shortest interval.

## ADR-046 Product structure: public website, trading app, separate admin console
**Decision.** The frontend is split into three areas:
- **Public website at `/`** (no sign-in): home, live markets, AI trading, security, about, and
  terms, privacy and risk pages, with Log in and Sign up buttons. Public prices come from
  CoinGecko, falling back to Coinbase when CoinGecko rate-limits, and from Coinbase exchange
  rates for forex.
- **Trading app at `/app`**, in a terminal layout: top navigation, a live ticker tape, a trade
  screen with watchlist, chart, trade panel and positions/orders, an account menu with
  Profile/Security/Paper accounts settings, and a phone tab bar.
- **Admin console at `/admin`** with its own layout: overview (operations), trading controls
  (kill switch and maintenance), users and audit, Model Lab, agents and the research library.

The design tokens move from navy and yellow to a neutral near-black with a blue accent; green and
red are reserved for gains, losses and buy/sell.

Separation of duties is enforced on the server, not just hidden in the UI:
- Trading endpoints (accounts, orders, portfolio, binary, per-account risk and autopilot) use
  `current_trader`, which refuses administrators (`403 admin_cannot_trade`).
- Administrators land in `/admin` and are redirected away from `/app`.
- The demo has a separate administrator account ("Explore the admin console"); "Launch demo"
  is a normal trader.

**Maintenance mode ("site on hold").** Administrators set it from Trading controls
(`POST /admin/maintenance`, audited). While it is on:
- traders get `503 maintenance` on sign-in, refresh and API calls, and see a notice;
- administrators keep access;
- the worker pauses AI bots and autopilot, while the order matcher keeps protective stops working.

Old links (`/wallet`, `/markets?...` in the app sense, etc.) redirect into `/app`, and every route
gets its own `index.html` on GitHub Pages so deep links answer 200.
**Why.** The product owner asked for a real product front door, a professional trading UI, a
proper settings area and an admin who manages the platform rather than trading on it.

## ADR-047 Self-service profile: edit name, export my data, close my account
**Decision.** Settings → Profile lets a trader do three things:
- **Edit their display name** (`PATCH /users/me`, audited).
- **Download everything held about them** as one JSON file (`GET /users/me/export`): profile,
  settings, paper accounts, orders, executions, positions, binary contracts and their own audit
  events.
- **Close their account** (`POST /users/me/close`, password required). Closing deactivates the
  user, revokes every session, closes their paper accounts, stops bots and autopilot, clears
  two-factor secrets and replaces the name and email with anonymous values, so the email can be
  used again. The ledger, trades and audit trail are append-only and stay, linked to the
  anonymous id. Administrators cannot close their own account.
**Why.** The product owner asked for a complete settings area, and the privacy page promises
data export and account closure.

## ADR-048 Price alerts, a beginner tour, and an unlisted admin sign-in
**Decision.**
- **Price alerts:** `price_alerts` table (migration 0018) and `/alerts` endpoints. Alerts are
  trader-only: list, create (`ABOVE`/`BELOW` a level, optional note, at most 50 active), cancel,
  and mark seen.
  - The worker checks active alerts every pass on fresh, open-market quotes only; stale or closed
    markets never trigger.
  - The app shows a header bell with an unread count and a "Price alert" box on the Trade screen,
    plus a desktop notification when one triggers, if the browser allows it.
  - The demo checks alerts whenever they are polled.
- **Guided tour:** a spotlight tour of the Dashboard (9 steps) that hands off to the Trade screen
  (7 steps). It starts by itself on the first visit to each page (remembered per browser) and can
  be replayed from the account menu ("Take the tour"). It does not start by itself in automated
  browsers (`navigator.webdriver`), so tests start it explicitly.
- **Admin sign-in:** the admin entrance is removed from the public login page. Administrators use
  the unlisted `/admin/login` (in the demo, "Open the demo admin console" is only there), and the
  admin console redirects there when signed out. Administrators can still sign in at `/login`
  with their own credentials.
**Why.** The product owner asked for alerts and a beginner tour, and for the admin login to be
reachable only by link.

## ADR-049 Binary bot trained and gated properly; the "explain it to me" coach
**Decision.**
- **Binary bot.** The single 70/30 split is replaced by five-fold purged walk-forward validation on
  about two days of 1-minute bars (3,000, up from 1,000). It now trades only when:
  - it has at least 60 confident out-of-sample calls;
  - the **95% Wilson lower bound** of their hit rate is above break-even;
  - the hit rate clears break-even plus the safety margin;
  - at least three quarters of the time periods beat break-even on their own;
  - today's call is confident enough.

  A statistical early guard pauses a live bot after 8 settled contracts once even the best case of
  its record (Wilson upper bound) is below break-even. The 20-contract guard still applies. The
  backend and the demo port are kept in sync.
- **Coach.** `POST /coach/ask` (trader-only, 60 questions an hour) answers in plain English from
  the trader's own data: account, recent binary contracts and the bot's state, the last AI desk run
  with its agents, closed trades and alerts.
  - Engines: `builtin` (default; deterministic templates and a glossary, also in the demo) or
    `claude` (`AUREX_COACH_ENGINE=claude`, the server's Anthropic key, Claude Opus 5.5 at low effort
    with server-side fallbacks, a system prompt limiting it to the supplied facts). Claude falls
    back to builtin on any API error, refusal or empty answer.
  - UI: an "Ask the coach" chat with suggested questions, also added to the guided tour.
**Why.** The bot traded after passing a single lucky test (1 win in 5 contracts on the live
demo). A confidence bound and consistency across time periods stop that. The coach turns the
platform's numbers into explanations a beginner can follow, and the Claude key never reaches the
public demo.

## ADR-050 Paper crypto perpetual futures with real order-book liquidity
**Decision.**
- **Product.** A new Futures screen (`/app/futures`, in the main menu and the guided tour) for
  paper LONG/SHORT positions on the crypto markets, with leverage from 1x to 10x
  (`AUREX_FUTURES_MAX_LEVERAGE`) and **isolated margin**: the most a position can lose is its
  margin. Paper only; no real orders are ever sent.
- **Liquidity.** Market orders walk the order book level by level, so a large order gets a worse
  average price, and an order bigger than the visible depth is refused.
  - The server uses Coinbase's public level-2 book (`/products/{id}/book?level=2`, top 50 levels,
    cached for 2 s). The demo reads the same book from the browser.
  - When that book is unavailable, a synthetic book is built around the quote (40 levels, 2 bps
    apart, about $25k at the top) and labelled "Synthetic".
- **Costs and liquidation.**
  - Taker fee: 0.05% of notional on open and close.
  - Maintenance margin: 0.5%. The liquidation price is
    `E ∓ (M − mmr·E·Q)/Q`, which is `E·(1 − 1/L + mmr)` for a long at leverage L.
  - The worker liquidates a position when the mid price crosses that level; the margin is lost
    and nothing more.
  - Funding: every 8 hours (00:00, 08:00 and 16:00 UTC) at 0.01%, with longs paying shorts. It is
    charged to or credited from the margin, which moves the liquidation price.
- **Ledger.**
  - Open: margin INVESTMENTS dr / CASH cr, fee FEES dr / CASH cr.
  - Close: margin back plus P&L to CASH.
  - Funding: REALISED_PNL against INVESTMENTS.

  Equity counts margin plus unrealised P&L, so the daily-loss and drawdown breakers see futures
  too.
- **Risk.** There are nine pre-trade checks, each recorded as a `RiskDecision` with source
  `futures`:
  1. no halt, kill switch or breaker;
  2. a fresh price;
  3. minimum margin of 1.00;
  4. enough cash for margin plus fee;
  5. ≤ 20% of equity per position;
  6. ≤ 50% of equity across all futures;
  7. ≤ 5 open positions;
  8. a size above the minimum lot;
  9. enough book depth.

  Requests are idempotent with `client_id`, and administrators cannot trade.
- **AI futures model.** `GET /futures/signal` gives LONG, SHORT or no trade on a 4-hour horizon.
  - It uses a logistic regression on 2,000 hourly bars and five-fold purged walk-forward, with
    non-overlapping out-of-sample trades charged the taker fee twice plus half a day of funding.
  - It suggests a trade only when:
    - there are at least 40 such trades;
    - the 95% lower bound of their mean return after costs is above zero;
    - at least three quarters of the periods are profitable;
    - the current call is at least 55% confident.
  - Its leverage suggestion is sized from volatility, so a 2×ATR move costs at most about 25% of
    margin (1x to 5x).
  - The backend and the demo port (`frontend/src/services/demo/futures.ts`) are kept in sync.
**Why.** The product owner asked for futures trading "with proper liquidity" and a model for it.
Walking a real book makes fills honest about size. Isolated margin and the caps keep a £100
account from being wiped out by one position. Like the binary bot, the model is judged after
costs with a confidence bound, so on most days it says "no trade".

## ADR-051 Automatic AI futures bot with stop-loss and time exits
**Decision.**
- **Control.** A one-button bot per paper account (`GET/POST /futures/bot`, `POST /futures/bot/run`,
  table `futures_bots`). Its defaults are BTC and ETH, 5% of equity as margin per trade (up to 20%),
  and at most 3x leverage (up to 5x in the UI, never above the platform's 10x maximum).
- **Entries.**
  - Every 15 minutes (`AUREX_FUTURES_BOT_INTERVAL_SECONDS`) the worker asks the AI futures model
    (ADR-050) about each market. The model's result is reused for 10 minutes.
  - The bot opens a position only when the model's validation passes, through the normal
    `FuturesService.open` path, so all nine risk checks, the order-book walk and the ledger apply.
  - Side comes from the model. Leverage is the model's volatility-based suggestion, capped by the
    bot's maximum.
  - The bot holds at most one position per market.
- **Exits.** Every bot position gets a stop-loss at the model's 2×ATR distance and a time exit at the
  model's 4-hour horizon. The worker checks both on every pass, and also while the site is on hold,
  because exits reduce risk. Liquidation still applies underneath, but with leverage sized to
  volatility the stop comes first.
- **Guards.** The bot pauses itself when:
  - the risk engine blocks trading (halt, kill switch, daily-loss or drawdown breaker);
  - after 8 closed trades, the optimistic end of the 95% range of its average return on margin is
    below zero;
  - after 20 closed trades, its average return on margin is negative.

  The emergency stop and closing the user account stop it.
- **Transparency.** Every cycle is recorded as a risk event, showing for each market whether the bot
  opened a trade (with leverage, margin and stop), found no trade (with the model's reason), is
  holding a position, or was refused by risk. The demo port runs the same logic in the browser.
**Why.** The product owner asked for a futures AI bot that trades automatically. Fixed exits and
statistical guards keep an automatic, leveraged strategy from running on when it has no edge, which
is what went wrong with the first binary bot.

## ADR-052 The binary bot trades only when the futures model agrees
**Decision.**
- The binary bot has a new setting, `require_futures_agreement` (on by default, migration 0021). It
  can be switched off under "Bot settings".
- When the setting is on and the binary model's validated signal says HIGHER or LOWER, the bot also
  asks the AI futures model (ADR-050: hourly bars, 4-hour horizon), reusing its result for up to 10
  minutes.
- It opens the contract only when the futures model points the same way (HIGHER needs LONG, LOWER
  needs SHORT) with at least the futures model's own 55% confidence. The futures model does not
  have to pass its own trade gate.
- Otherwise the bot logs "no trade" with the reason: the models disagree, the futures model is not
  confident enough, it is unavailable, or the market is not crypto (the futures model covers crypto
  only).
- The futures view (direction, confidence, whether it would trade) is stored with each contract's
  signal. The backend and the demo port are kept in sync.
**Why.** The product owner asked for the binary bot to trade only when the futures model agrees.
Requiring the short-horizon call to go with the model's view of the bigger trend is a second,
independent filter. Requiring both models to pass their full validation as well would mean the
bot almost never trades on real data, so agreement means the same direction at the futures model's
usual confidence threshold.
