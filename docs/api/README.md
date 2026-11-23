# API

Interactive docs: `/api/v1/docs` (Swagger) and `/api/v1/redoc`. Schema: `/api/v1/openapi.json`.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/system/health` | – | Liveness + DB check (503 if DB down) |
| GET | `/system/info` | – | Version, environment, trading mode (`PAPER`) |
| POST | `/auth/register` | – | Create user (if registration enabled) |
| POST | `/auth/login` | – | Access token + refresh cookie (rate-limited) |
| POST | `/auth/refresh` | cookie | Rotate refresh token, new access token |
| POST | `/auth/logout` | cookie | Revoke session |
| GET | `/auth/me` | bearer | Current user |
| POST | `/auth/password` | bearer | Change password; revokes other sessions |
| GET/PATCH | `/users/me/settings` | bearer | Preferences |
| GET | `/users/me/activity` | bearer | Caller's own audit events |
| GET/POST | `/accounts` | bearer | List / create paper accounts |
| GET | `/accounts/{id}` | bearer | Account with cash + equity |
| GET | `/accounts/{id}/balances` | bearer | Chart-of-accounts balances |
| GET | `/accounts/{id}/ledger` | bearer | Journal (paginated) |
| POST | `/accounts/{id}/deposits` | bearer | Virtual deposit (`Idempotency-Key` supported) |
| POST | `/accounts/{id}/withdrawals` | bearer | Virtual withdrawal (`Idempotency-Key` supported) |
| GET | `/markets/status` | bearer | Session status for each market |
| GET | `/markets/overview` | bearer | All instruments with quotes, grouped by asset class |
| GET | `/markets/instruments?asset_class=&q=` | bearer | Instrument registry |
| GET | `/markets/instruments/{slug}` · `/quote` | bearer | Instrument + quote (`stale`, `tradable`, `source`) |
| GET | `/markets/instruments/{slug}/candles?timeframe=&limit=&indicators=` | bearer | OHLCV (1m–1d) + sma/ema/rsi14/bb20/macd |
| GET/POST/DELETE | `/markets/watchlist[/items/{slug}]` | bearer | Default watchlist |
| POST | `/markets/backfill` | admin | Backfill candles (audited) |
| WS | `/markets/stream` | in-band token | Live quotes (see `docs/architecture/market-data.md`) |
| GET | `/research/status` | bearer | Engine, embedding model, corpus size |
| GET | `/research/documents[?q,doc_type,symbol]` · `/research/documents/{id}` | bearer | Corpus listing and detail (with chunks) |
| POST | `/research/documents` · `/documents/upload` · `/documents/fetch` | admin | Ingest text or HTML, a file (PDF/HTML/text), or an allow-listed URL or RSS feed |
| DELETE | `/research/documents/{id}` | admin | Remove a document and its chunks |
| POST | `/research/samples` | admin | Load the fictional sample corpus |
| GET | `/research/search?q=&symbols=&k=` | bearer | Hybrid retrieval |
| POST | `/research/ask` | bearer | Grounded report (rate-limited per user) |
| GET | `/research/reports` · `/research/reports/{id}` | bearer | The caller's own reports |
| GET | `/ai/agents` · PATCH `/ai/agents/{name}` | bearer · admin | Agent registry and configuration |
| POST | `/ai/run` | bearer | Run the agent department on `{symbol, account_id?}` (rate-limited) |
| GET | `/ai/runs` · `/ai/runs/{id}` | bearer | The caller's runs, with findings, reasons and proposal |
| GET | `/ai/proposals` · POST `/ai/proposals/{id}/dismiss` | bearer | Trade proposals (`effective_status` includes EXPIRED) |
| GET | `/ml/algorithms` · `/ml/models` · `/ml/versions/{id}` · `/ml/champion?symbol=` | bearer | Model zoo, registry, version detail |
| POST | `/ml/train` | admin | Train a candidate with purged walk-forward validation (rate-limited) |
| POST | `/ml/versions/{id}/promote` · `/retire` · `/drift-check` | admin | Gated promotion, retirement, drift monitoring (audited) |
| GET | `/backtests/strategies` | bearer | Strategy catalogue with parameter rules and grid size |
| POST | `/backtests` | bearer | Run `{strategy, symbol, days, params?, optimise, capital, costs}` (rate-limited) |
| GET | `/backtests` · `/backtests/{id}` | bearer | The caller's backtests and full results |
| GET | `/admin/users` · PATCH `/admin/users/{id}` | admin | User management |
| GET | `/admin/audit` · `/admin/audit/verify` | admin | Audit log + chain verification |

**Money** is always a decimal **string** in JSON (`"100000.00000000"`), max 8 dp.

**Errors**: `{"error": {"code", "message", "details", "request_id"}}` with codes
`validation_error`, `unauthorized`, `forbidden`, `not_found`, `conflict`,
`rate_limited`, `business_rule_violation`, `market_data_unavailable` (503).

Accounts belonging to other users return `404` (existence is not disclosed).
