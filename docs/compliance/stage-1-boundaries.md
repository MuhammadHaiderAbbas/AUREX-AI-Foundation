# Stage 1 operating boundaries

> This is an engineering control document, **not legal advice**. A UK financial
> regulatory solicitor must review the regulatory perimeter before any public
> launch, financial promotion, or real-money functionality.

Stage 1 is a **private research and paper-trading system**. The codebase enforces:

| Boundary | How it is enforced |
|---|---|
| No real money | No payment, custody or broker integrations exist. Deposits/withdrawals are virtual ledger postings, labelled as such in UI and API docs. |
| Paper accounts only | `CHECK (mode = 'PAPER')` on `trading_accounts`; `live_trading_enabled` hard-coded `False`. |
| No customer funds / custody | No client-money ledger accounts; virtual balances capped at 10,000,000. |
| No public onboarding | Set `AUREX_ALLOW_REGISTRATION=false` for private deployments; admin accounts are created only via CLI. |
| Traceability | Every consequential action is audited with actor, IP, request ID. |
| Binary options are simulation only | Binary contracts exist only as paper ledger postings. There is no real-money path, no autopilot or AI execution for them, and the UI and API state that retail binary options are banned in the UK (FCA, April 2019) and restricted in the EU/EEA. Must never be offered for real money to UK/EEA retail users. |

## Items to resolve with counsel before Stage 2/3
- Regulatory perimeter for each asset class (crypto, spot FX, CFDs, shares, ETFs).
- Whether even a paper binary-options simulator may be promoted publicly in the UK (it
  must not be presented as a route to real binary trading).
- Whether research/signals features constitute advice or arranging.
- Financial-promotion rules for marketing (including cryptoasset promotions).
- Current status and timelines of the UK cryptoasset regime — verify directly with the FCA.
- Data protection (UK GDPR) — DPIA before onboarding external users.
