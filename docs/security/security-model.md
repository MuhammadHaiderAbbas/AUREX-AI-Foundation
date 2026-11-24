# Security model

## Implemented in Phase 1
- Argon2id password hashing; 12+ char passwords with 3 character classes; transparent rehash.
- Login rate limiting per IP+email (5/min). In-process; moves to Redis in Phase 12.
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

- Research ingestion: an https-only host allow-list, no redirects, 10 MB cap, and
  `defusedxml` for feeds (XXE / entity expansion). Fetched HTML has scripts and styles removed.
- LLM safety: source text is passed as untrusted data, output is schema-constrained, every
  claim is quote-checked, nothing a model produces reaches execution, and questions are
  rate-limited per user.

## Implemented in Phase 11 (see `threat-model.md`)
- TOTP two-factor authentication: RFC 6238 with a ±1 step window and replay protection.
  Seeds are encrypted with AES-256-GCM; there are 10 single-use recovery codes; verification is
  rate-limited; admins can reset 2FA; enabling it signs out one-factor sessions.
- Password policy adds a block-list of common bases, keyboard runs and repeats (after stripping
  decoration and l33t substitutions) and rejects the user's name or email. Changing to the same
  password is refused.
- Per-account lockout across IPs (default 20 failures / 15 min), per-IP registration limit, a
  global per-IP API rate limit (600/min) and request body limits (1 MiB; 11 MiB for uploads,
  enforced for chunked bodies too).
- Session management: list sessions, revoke one, revoke all others.
- Origin check on the cookie-authenticated endpoints.
- JWT `kid` with rotation via `AUREX_JWT_PREVIOUS_SECRETS`. Secrets can come from files
  (`*_FILE`), and production refuses weak or rotated-in secrets that are too short, CORS
  wildcards or non-https origins, and the default DB password.
- ML artifacts are HMAC-signed and verified before unpickling.
- Audit chain export (JSON Lines) with offline verification (`app.cli audit-verify-file`),
  plus `audit-verify` and `audit-export` CLIs.
- API headers: CSP `default-src 'none'`, COOP/CORP, Permissions-Policy, and HSTS in
  staging/production. OpenAPI docs are off in production.
- Containers: proxy-only trust for forwarded headers, a read-only root filesystem,
  `cap_drop: ALL`, `no-new-privileges` and a private network. The CSP is tightened
  (`object-src 'none'`), and the static demo now ships a CSP meta tag.
- CI: pip-audit, npm audit, Bandit, detect-secrets (reviewed baseline) and Trivy image scans
  on every PR and weekly; Dependabot for pip, npm, actions and Docker.

## Implemented in Phase 12
- Redis-shared rate limits across replicas (fail open, counted and alerted).
- External audit anchoring (file and signed webhook) with verification; append-only `audit_anchors`.
- Admin endpoints require 2FA outside development.
- All production secrets as files (Docker secrets); the database and Redis URLs included.
- Backups (`umask 077`, optional GPG encryption, SHA-256 manifest) and weekly restore drills
  with integrity checks.
- Metrics are token-protected, and Grafana is bound to localhost.
- Images are scanned before release.

## Planned (before any live-trading stage)
| Control | Notes |
|---|---|
| Secrets manager for broker credentials (never in DB, logs or frontend) | with the first broker integration |
| Broker keys without withdrawal permission, IP allow-listing | with the first broker integration |
| External penetration test | recorded as a go-live attestation |
