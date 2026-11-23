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
| GET | `/admin/users` · PATCH `/admin/users/{id}` | admin | User management |
| GET | `/admin/audit` · `/admin/audit/verify` | admin | Audit log + chain verification |

**Money** is always a decimal **string** in JSON (`"100000.00000000"`), max 8 dp.

**Errors**: `{"error": {"code", "message", "details", "request_id"}}` with codes
`validation_error`, `unauthorized`, `forbidden`, `not_found`, `conflict`,
`rate_limited`, `business_rule_violation`.

Accounts belonging to other users return `404` (existence is not disclosed).
