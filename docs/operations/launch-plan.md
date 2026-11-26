# Launch plan

Where AUREX AI stands and what it takes to put it in front of people. Three different
launches, in increasing order of difficulty. This is an engineering plan, not legal advice.

## Where it stands

Built and tested (244 backend tests, full-stack and demo browser tests in CI):

- Markets for crypto, FX, stocks and ETFs; live quotes and candles; synthetic, Coinbase and ECB data.
- Research engine, eight-agent AI desk, quant models with gated promotion, event-driven backtester.
- Paper execution (market/limit/stop, brackets), double-entry ledger, risk engine with breakers and kill switches, autopilot.
- Binary options simulator with its own risk gate, and a one-button AI binary bot that trades only with a validated out-of-sample edge and pauses itself when it stops winning.
- Live account stream, live charts, analytics, 2FA, audit chain with external anchoring, backups with restore drills, metrics and alerts, a production compose stack and a release workflow.
- A public static demo on GitHub Pages (simulated data, runs in the browser).

Deliberately not built: any real-money path. Live trading is disabled in code.

## Launch 1 — private, for yourself (days)

The production stack is ready; it needs a server, a domain and an operator.

1. **Server**: one Linux VM with Docker (2 vCPU, 4 GB RAM is plenty), plus a managed PostgreSQL 16 with pgvector (or Postgres on the same VM to start).
2. **Domain**: point an A record at the VM. Caddy obtains HTTPS certificates automatically.
3. **Release**: `git tag v1.0.0 && git push origin v1.0.0` builds, scans and pushes the images to GHCR.
4. **Configure**: in `infrastructure/deployment/`, copy `.env.prod.example` to `.env.prod`, set the domain and image tag, run `./make-secrets.sh`, put the database URLs in `secrets/`.
5. **Start**: `docker compose -f docker-compose.prod.yml --env-file .env.prod up -d`, then `--profile monitoring` for Prometheus and Grafana.
6. **Admin**: `python -m app.cli create-admin` inside the backend container; enrol 2FA at first sign-in (it is enforced for admins in production).
7. **Real prices**: set `AUREX_MARKET_DATA_MODE=live`. Crypto streams from Coinbase with no key. Frankfurter/ECB FX is a daily reference rate, so real-time forex, stocks and ETFs need a vendor key (for example Twelve Data, Finnhub or Alpaca) and a small provider adapter; the key is stored as a server secret, never in the browser.
8. **Keep registration off** (`AUREX_ALLOW_REGISTRATION=false`) and check the Operations page until every go-live gate is green.

Step-by-step detail: `docs/operations/deployment.md` and `docs/operations/runbooks.md`.

## Launch 2 — a public paper-trading platform (weeks to months)

Paper trading with virtual money is not regulated investment business in itself, but
inviting the public in raises questions that need answers before launch:

- **Legal review** by a UK financial-regulation solicitor: whether AI signals, the autopilot or the bot amount to advice or a financial promotion; how crypto and binary-options content may be presented (`docs/compliance/stage-1-boundaries.md` lists the open items).
- **Privacy (UK GDPR)**: privacy notice, lawful basis, retention periods, a processor agreement with the host, and **self-service account deletion and data export, which are not built yet**.
- **Terms of service** and clear "virtual money, not advice" wording everywhere (largely in place).
- **Security**: an independent penetration test; review of the threat model; a disclosure policy.
- **Operations**: support channel, status page, on-call for the alerts that already exist, capacity testing for the account stream (one small query per connected user per second).
- **Abuse**: email verification, CAPTCHA or rate limits on registration (rate limits exist; verification does not).

## Launch 3 — real money (a different product)

- **Binary options for UK/EEA retail: not possible.** They have been banned for retail customers in the UK since April 2019 and are restricted across the EU/EEA. This platform will keep them as a simulator.
- **Real trading for yourself** (crypto, shares) would mean connecting your own broker or exchange account through its API. That is technically a contained change (a live execution adapter behind the same risk gate), but it should only happen after months of paper results that show an edge after costs, with small limits and the kill switches tested. Live trading stays disabled in code until that decision is made and reviewed.
- **Real trading for other people** requires FCA authorisation (or an authorised partner), client-money rules, KYC/AML and much more. It is not a software switch.

## About "press one button and it makes profit"

The one button exists: the AI binary bot. What no software can honestly promise is profit.
With an 80% payout a binary contract loses money unless predictions are right more than 55.6%
of the time, which is very hard to sustain on real prices. That is why the bot only trades
when its model has beaten that rate on recent data it had not seen, and pauses itself when its
live win rate falls below break-even. On the synthetic demo feed it often finds an "edge",
because that feed is built from smooth cycles; on real prices expect it to trade rarely.
