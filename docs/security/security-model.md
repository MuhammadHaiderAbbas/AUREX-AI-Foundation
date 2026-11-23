# Security model

## Implemented in Phase 1
- Argon2id password hashing; 12+ char passwords with 3 character classes; transparent rehash.
- Login rate limiting per IP+email (5/min) — in-process; moves to Redis in Phase 11.
- Constant-time-ish login for unknown users (dummy hash verification).
- 15-minute access JWT in memory; rotating refresh token in `httpOnly`, `SameSite=Strict`,
  path-scoped cookie; reuse detection revokes the session family.
- Server-side session check on every request (instant revocation on logout, disable,
  role change, password change).
- RBAC: `admin` / `user`; admins cannot demote or disable themselves.
- Tenant isolation: all account queries are filtered by owner; foreign IDs → 404.
- Append-only ledger + audit tables (DB triggers); hash-chained audit with verifier.
- Idempotent, row-locked cash movements.
- Security headers (API and Caddy): CSP `default-src 'self'`, HSTS, `nosniff`,
  `X-Frame-Options: DENY`, `no-referrer`; `Cache-Control: no-store` on API responses.
- Startup refuses `staging`/`production` with a default/short JWT secret or insecure cookies.
- Containers run as non-root; DB/Redis ports bound to 127.0.0.1 in Compose.
- Request IDs are sanitised before being logged or audited.

## Planned
| Control | Phase |
|---|---|
| TOTP MFA + recovery codes | 11 |
| Redis-backed distributed rate limiting | 3/11 |
| Secrets manager for broker credentials (never in DB/logs/frontend) | 12 |
| Broker keys without withdrawal permission, IP allow-listing | 12 |
| Signed internal requests between OMS and risk gate | 8–9 |
| External anchoring of audit head hash | 11 |
| Backups + restore drills, monitoring (Prometheus/Grafana) | 11 |
| Penetration test | 11 |
