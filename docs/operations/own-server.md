# Run AUREX on your own server (real prices, private)

About an hour, once. Cost: roughly £4–10 a month for the server, and optionally ~£8 a year for
a domain. Everything stays paper trading: live trading is disabled in code.

What you get compared with the public demo:

| | Public demo | Your server |
|---|---|---|
| Crypto (12 coins) | live (Coinbase) | live (Coinbase) |
| Forex | live rates, simulated intraday history | live rates (tradable), ECB daily history, simulated intraday |
| US stocks and ETFs (AAPL, MSFT, NVDA, TSLA, NFLX, SPY, QQQ, DIA, GLD gold, USO oil) | simulated | **live (Alpaca, free key)** |
| Data stored | in your browser only | PostgreSQL, backed up daily, restore-tested weekly |
| Bot and autopilot | run while the page is open | run 24/7 on the server |

UK shares (SHEL.L, AZN.L, ISF.L) and index levels need a paid feed and stay simulated.

## 1. Accounts you need (all free except the server)

1. **A server**: Hetzner Cloud (CX22, ~€4/month) or DigitalOcean (Basic droplet, 2 GB, ~$12/month).
   Choose **Ubuntu 24.04** and add your SSH key when creating it.
2. **Alpaca** (free market data): sign up at alpaca.markets, open the **Paper Trading** dashboard,
   and generate an API key. You get a *Key ID* and a *Secret Key*. Market data on the free plan
   uses the real-time IEX feed. Keep both values private.
3. **A domain (optional)**: any registrar. Without one, use `<your-server-ip>.sslip.io` as a free
   hostname; HTTPS still works.

## 2. Prepare the server

```bash
ssh root@YOUR_SERVER_IP
```

```bash
curl -fsSL https://get.docker.com | sh
```

```bash
git clone https://github.com/MuhammadHaiderAbbas/AUREX-AI-Foundation.git aurex && cd aurex/infrastructure/deployment
```

If you use a domain, point its A record at the server's IP now.

## 3. Publish the images (once per version, from your computer or GitHub)

Create a release tag; GitHub Actions builds, scans and pushes the images to GHCR:

```bash
git tag v1.0.0 && git push origin v1.0.0
```

The packages are private by default. Either make the three `aurex-*` packages public
(GitHub → your profile → Packages → package settings), or log the server in to GHCR with a
personal access token that has `read:packages`:

```bash
echo YOUR_TOKEN | docker login ghcr.io -u MuhammadHaiderAbbas --password-stdin
```

## 4. Configure

```bash
cp .env.prod.example .env.prod && nano .env.prod
```

Set `AUREX_DOMAIN` (your domain or `YOUR_IP.sslip.io`), `AUREX_IMAGE_OWNER=muhammadhaiderabbas`,
`AUREX_VERSION=v1.0.0`, and keep `AUREX_MARKET_DATA_MODE=live`.

Create the secrets, with PostgreSQL on this same server:

```bash
./make-secrets.sh --local-db
```

Paste your Alpaca key into the two files it created (one value per file, nothing else):

```bash
nano secrets/alpaca_key_id
```

```bash
nano secrets/alpaca_secret_key
```

## 5. Start

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod --profile local-db up -d
```

Create your administrator account (you will enrol two-factor authentication at first sign-in):

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod exec backend python -m app.cli create-admin --email you@example.com --name "Your Name"
```

Open `https://YOUR_DOMAIN`, sign in, and check **Operations**: every go-live gate should turn
green over the first day (backups and restore drills run on their schedule). On **Markets**,
AAPL and the other US instruments now show `source Alpaca` during US market hours.

Optional monitoring (Prometheus and Grafana, reachable through an SSH tunnel only):

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod --profile local-db --profile monitoring up -d
```

## 6. Keep it healthy

- Upgrades: tag a new version, set `AUREX_VERSION` in `.env.prod`, run the `up -d` command again.
- Backups land in the `backups` volume daily; copy them off the server (see `runbooks.md`).
- If prices stop: **Operations** shows the provider errors; an Alpaca 401/403 means the key in
  `secrets/` is wrong or was revoked.

More detail: `deployment.md` (architecture and hardening) and `runbooks.md` (incidents).
