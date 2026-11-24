# Threat model (Phase 11)

Method: STRIDE over the system's trust boundaries, reviewed against the code as of Phase 11.
Each threat lists its mitigations and where they are tested. Residual risks are stated plainly.

## Assets
1. **Accounts and sessions:** credentials, refresh tokens, access tokens, TOTP seeds.
2. **Financial records:** the double-entry ledger, orders, executions and positions. These are
   virtual today, but they must be trustworthy before real money is ever involved.
3. **Evidence:** the audit chain, risk decisions and events. These must be tamper-evident.
4. **Decision logic:** risk limits, the kill switches, and ML model artifacts (code that is
   executed when an artifact is loaded).
5. **Availability** of the risk gate and the background matcher.

## Trust boundaries
```
Browser (SPA) ──HTTPS──► Caddy (CSP, HSTS) ──► FastAPI (auth, rate limits, body limits)
                                                  ├─► Postgres (append-only triggers, check constraints)
                                                  ├─► market data providers (HTTPS, allow-listed)
                                                  ├─► research fetcher (allow-listed hosts, no redirects)
                                                  └─► Anthropic API (optional; output schema-validated)
Operators ──► CLI (create-admin, audit export/verify, artifact signing)
CI ──► GitHub Actions (dependency, SAST, secret and image scans)
```

## STRIDE

| # | Threat | Mitigations | Tests |
|---|---|---|---|
| S1 | Credential stuffing / password guessing | Argon2id hashing; per IP+email limit; **per-account lockout across IPs**; **block-list of common bases, keyboard runs and personal info**; timing-equalised unknown-user path | `test_security.py` (lockout, policy), `test_auth.py` |
| S2 | Stolen password | **TOTP two-factor authentication** (encrypted seed, replay-protected steps, single-use recovery codes, rate-limited verification); enabling 2FA signs out one-factor sessions | `test_mfa.py` |
| S3 | Session theft / fixation | 15-minute access token held in memory; rotating refresh token in an `httpOnly`, `SameSite=Strict`, path-scoped cookie; reuse detection kills the token family; **users can list and revoke sessions** | `test_auth.py`, `test_security.py` |
| S4 | Cross-site request forgery on cookie endpoints | SameSite=Strict; **Origin check on `/auth/refresh` and `/auth/logout`**; every other endpoint requires a bearer token | `test_security.py` |
| S5 | Forged or replayed JWTs | Algorithm pinned; `exp`, `sub`, `iat` required; **`kid`-based key rotation**; unknown keys and `alg=none` rejected; server-side session check on every request | `test_security.py` |
| T1 | Ledger or audit tampering | Append-only DB triggers; balanced-entry trigger; hash-chained audit; **offline-verifiable exports** (contiguous ids, link and hash checks) | `test_ledger_integrity.py`, `test_audit_admin.py`, `test_security.py` |
| T2 | Malicious ML artifact (pickle → code execution) | **HMAC-SHA256 with a server-held key** verified before unpickling (a database write alone is not enough); SHA-256 kept as a second check; unsigned legacy artifacts refused until an operator signs them with `ml-sign-artifacts` | `test_ml_api.py` |
| T3 | Order or limit tampering via the API | Pydantic validation; DB check constraints (limits ceilings, order shapes, non-NULL prices); owner scoping returns 404 for foreign ids | `test_risk_*`, `test_trading.py` |
| R1 | Users deny actions | Audit records for logins, 2FA events, orders, risk controls, exports and admin actions, including the IP and request ID | across suites |
| I1 | Data leakage across tenants | Every query scoped by owner; foreign resources answer 404; analytics and exports scoped the same way | privacy tests in each suite |
| I2 | Secrets in the repository | `detect-secrets` with a reviewed baseline in CI; secrets read from env or `*_FILE`; production refuses default secrets, CORS wildcards and the default DB password | `security.yml`, `test_config.py` |
| I3 | Sensitive data in browsers or logs | No tokens in `localStorage`; `Cache-Control: no-store`; logs record the path only (no query or body); TOTP seeds AES-GCM encrypted at rest | `test_security.py`, `test_mfa.py` |
| I4 | Spoofed client IPs | uvicorn trusts `X-Forwarded-For` **only from the reverse proxy** (was `*`) | Dockerfile, compose |
| D1 | Request floods / large bodies | **Per-IP API rate limit**; **body-size limit, including chunked bodies**; endpoint limits on login, registration, agent runs, training, backtests, orders and autopilot cycles | `test_security.py` |
| D2 | Runaway automated trading | Risk engine order-rate check engages the kill switch; breakers; emergency stop; platform halt | `test_risk_*` |
| E1 | Privilege escalation | RBAC checked server-side; admins cannot demote, disable or reset 2FA for themselves; role changes revoke sessions | `test_audit_admin.py`, `test_mfa.py` |
| E2 | XSS leading to token theft | React escaping and no `dangerouslySetInnerHTML`; CSP `script-src 'self'` (header in Caddy, meta tag in the static demo); **fonts not inlined, so `font-src 'self'` holds** | CSP check in demo e2e |
| E3 | Injection (SQL / CSV / headers / XXE / SSRF) | ORM with bound parameters (raw SQL only joins fixed fragments); CSV formula guard; **download filenames sanitised**; `defusedxml`; research fetch allow-list, HTTPS only, no redirects | `test_security.py`, `test_analytics_api.py`, `test_research_*` |
| E4 | Vulnerable dependencies | **pip-audit, npm audit, Trivy (images) in CI weekly and on every PR**; Dependabot; **Starlette advisories fixed by upgrading FastAPI 0.115 → 0.165** | `security.yml` |

## Findings from the Phase 11 review (all fixed)

| ID | Finding | Severity | Fix |
|---|---|---|---|
| F1 | uvicorn trusted `X-Forwarded-For` from any client: spoofable IPs bypass per-IP limits and forge audit IPs | High | Trust only the proxy's address |
| F2 | No registration rate limit | Medium | Per-IP limit (10/hour) |
| F3 | Account name echoed into `Content-Disposition` | Low | Filename sanitised to `[A-Za-z0-9_-]` |
| F4 | Login limit keyed on IP+email only; a distributed attack on one account was not capped | Medium | Per-account lockout across all IPs, audited |
| F5 | No request body limit (memory exhaustion) | Medium | 1 MiB JSON / 11 MiB upload, including chunked bodies |
| F6 | No global rate limit | Medium | Per-IP limit (600/min by default) |
| F7 | Cookie endpoints relied only on SameSite | Low | Origin check added |
| F8 | OpenAPI and Swagger exposed in production | Low | Off outside development and test unless enabled explicitly |
| F9 | `assert` used for runtime invariants (removed under `python -O`) | Low | Explicit checks |
| F10 | Starlette 0.46.2 with 7 published advisories (PYSEC-2026-*) | High | FastAPI 0.165 / Starlette 1.10 |
| F11 | Pickle artifacts checked only against a hash stored in the same DB row | High | HMAC with a server-held key |
| F12 | CSP blocked inlined fonts: would have broken the deployed UI under the Caddy CSP | Medium (availability) | Fonts no longer inlined |
| F13 | CORS allowed methods omitted PUT (cross-origin limit updates would fail) | Low | Added |

## Residual risks and where they are addressed
- ~~In-process rate limits~~: shared through Redis in Phase 12. They fail open on a Redis
  outage, by design and alerted on.
- ~~The audit head is not anchored off-site~~: automated in Phase 12. The guarantee depends on
  operators keeping the anchor file or webhook receiver outside database administrators'
  reach (see the runbook).
- **No external penetration test yet.** This review was internal; an external test is planned
  before any live-trading stage.
- **The static demo** stores everything, including demo TOTP seeds, in the visitor's own
  `localStorage`. It is a demonstration, not a security boundary, as the demo banner says.
- ~~Backups, restore drills, monitoring~~: Phase 12.
