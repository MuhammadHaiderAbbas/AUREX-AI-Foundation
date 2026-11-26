# Run AUREX for free

Two ways, both £0. Everything stays paper trading.

| | A. Your own computer | B. Oracle Cloud Always Free |
|---|---|---|
| Cost | £0, no card | £0, a card is needed once for identity checks (Always Free resources are not charged) |
| Runs | while the computer is on and awake | 24/7 |
| Address | `http://localhost:8080` (only you) | `https://YOUR-IP.sslip.io` (from any device) |
| Setup | about 20 minutes | about an hour |

Both get live crypto (12 coins), live forex rates and, with a free Alpaca key, live US stocks.
Get the key first: sign up at alpaca.markets, open **Paper Trading**, then **API Keys** → **Generate**.
Keep the Key ID and Secret Key private.

## A. Your own computer

1. Install **Docker Desktop** (docker.com/products/docker-desktop). On Windows, accept the WSL 2
   option it offers and restart. At least 8 GB RAM is recommended.
2. Get the code: on GitHub, **Code** → **Download ZIP**, then unzip it. Or:
   `git clone https://github.com/MuhammadHaiderAbbas/AUREX-AI-Foundation.git`
3. In the project folder (the one containing `docker-compose.yml`), create a file named `.env`:
   ```
   AUREX_MARKET_DATA_MODE=live
   AUREX_ALPACA_KEY_ID=your key id
   AUREX_ALPACA_SECRET_KEY=your secret key
   ```
   `.env` is ignored by git, so the keys never leave your computer. Leave the Alpaca lines out to
   keep stocks simulated.
4. Open a terminal in that folder and start it (the first build takes 5–15 minutes):
   `docker compose up -d --build`
5. Open `http://localhost:8080` and **Create account**. Optionally, make an administrator account
   instead (two-factor sign-in is enrolled on first login):
   `docker compose exec backend python -m app.cli create-admin --email you@example.com --name "Your Name"`

Stop with `docker compose stop`, start again with `docker compose start`. Your data is kept.
While the computer sleeps, the bot does not run and live 30-second bars are not recorded.

## B. Oracle Cloud Always Free (24/7)

1. Sign up at oracle.com/cloud/free. Pick a home region close to you. It cannot be changed later.
2. **Create a VM instance**:
   - Image: **Ubuntu 24.04**.
   - Shape: **Ampere A1 (VM.Standard.A1.Flex)**, 2 OCPU and 12 GB RAM (inside the free allowance).
   - Upload your SSH public key.

   If it says "out of capacity", try another availability domain or try again later.
3. Open the web ports in two places:
   - **Cloud firewall:** instance → subnet → **Security List** → **Add ingress rules** for source
     `0.0.0.0/0`, TCP ports `80` and `443`.
   - **Server firewall:** Oracle's Ubuntu images also block them locally. After logging in, run:
     ```bash
     sudo iptables -I INPUT 6 -p tcp -m multiport --dports 80,443 -m state --state NEW -j ACCEPT
     sudo apt-get install -y iptables-persistent && sudo netfilter-persistent save
     ```
4. Log in (`ssh ubuntu@YOUR_IP`), then install Docker and the code:
   ```bash
   curl -fsSL https://get.docker.com | sudo sh && sudo usermod -aG docker ubuntu && newgrp docker
   git clone https://github.com/MuhammadHaiderAbbas/AUREX-AI-Foundation.git aurex && cd aurex/infrastructure/deployment
   cp .env.prod.example .env.prod && nano .env.prod
   ```
   Set `AUREX_DOMAIN=YOUR_IP.sslip.io`, `AUREX_IMAGE_OWNER=local` and `AUREX_VERSION=local`.
5. Create the secrets, then paste the Alpaca values, one per file:
   ```bash
   ./make-secrets.sh --local-db
   nano secrets/alpaca_key_id
   nano secrets/alpaca_secret_key
   ```
6. Build on the server and start. The first build takes 10–20 minutes. No published images or
   GitHub packages are needed, and it builds natively for ARM.
   ```bash
   docker compose -f docker-compose.prod.yml -f docker-compose.build.yml --env-file .env.prod --profile local-db up -d --build
   docker compose -f docker-compose.prod.yml --env-file .env.prod exec backend python -m app.cli create-admin --email you@example.com --name "Your Name"
   ```
7. Open `https://YOUR_IP.sslip.io`. Registration is off on the server, so sign in as the
   administrator.

Upgrade later: `git pull`, then run the same `up -d --build` command again.
Backups, restore drills and monitoring work as described in `own-server.md`.
