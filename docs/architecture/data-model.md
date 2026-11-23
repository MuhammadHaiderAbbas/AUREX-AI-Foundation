# Data model — Phase 1

| Table | Purpose | Key constraints |
|---|---|---|
| `roles` | `admin`, `user` (seeded by migration) | unique name |
| `users` | accounts; Argon2id hash | unique lower-cased email |
| `user_sessions` | refresh-token sessions (hash only), rotation family | unique token hash |
| `user_settings` | timezone, reporting currency, theme | 1:1 with user |
| `trading_accounts` | paper accounts | `CHECK (mode = 'PAPER')` |
| `ledger_accounts` | chart of accounts per trading account | unique (account, code, currency) |
| `ledger_transactions` | journal headers (`INITIAL_FUNDING`, `VIRTUAL_DEPOSIT`, …) | unique (account, idempotency_key); append-only |
| `ledger_entries` | DEBIT/CREDIT postings | `amount > 0`; balanced per txn (deferred trigger); append-only |
| `audit_logs` | hash-chained audit trail | unique hash; append-only |

## Chart of accounts (per paper account)

| Code | Type | Normal side |
|---|---|---|
| `CASH` | ASSET | debit |
| `INVESTMENTS` | ASSET | debit |
| `OPENING_EQUITY` | EQUITY | credit |
| `CAPITAL_CONTRIBUTIONS` | EQUITY | credit |
| `CAPITAL_WITHDRAWALS` | EQUITY (contra) | debit |
| `REALISED_PNL` | INCOME | credit |
| `FEES` | EXPENSE | debit |

## Postings

| Event | Debit | Credit |
|---|---|---|
| Initial virtual funding | CASH | OPENING_EQUITY |
| Virtual deposit | CASH | CAPITAL_CONTRIBUTIONS |
| Virtual withdrawal | CAPITAL_WITHDRAWALS | CASH |
| *Buy (Phase 8)* | INVESTMENTS | CASH |
| *Fee (Phase 8)* | FEES | CASH |
| *Sell (Phase 8)* | CASH | INVESTMENTS (+ REALISED_PNL difference) |

Equity = Σ assets − Σ liabilities. The API also reports `ledger_balanced`
(Σ debits = Σ credits across the account) as a continuous integrity check.
