#!/usr/bin/env bash
# Creates ./secrets with random keys (mode 600). Existing files are never overwritten.
#   ./make-secrets.sh             managed Postgres: fill in secrets/database_url and drill_admin_url by hand
#   ./make-secrets.sh --local-db  Postgres runs on this server (docker compose --profile local-db)
set -euo pipefail
cd "$(dirname "$0")"
umask 077
mkdir -p secrets
rand() { python3 -c 'import secrets; print(secrets.token_urlsafe(48))'; }
for f in jwt_secret data_key artifact_key metrics_token grafana_admin_password redis_password postgres_password; do
  [[ -s "secrets/$f" ]] || rand > "secrets/$f"
done
[[ -s secrets/redis_url ]] || echo "redis://:$(cat secrets/redis_password)@redis:6379/0" > secrets/redis_url
if [[ "${1:-}" == "--local-db" ]]; then
  for f in database_url drill_admin_url; do
    [[ -s "secrets/$f" ]] || echo "postgresql+asyncpg://aurex:$(cat secrets/postgres_password)@postgres:5432/aurex" > "secrets/$f"
  done
fi
for f in database_url drill_admin_url; do
  [[ -s "secrets/$f" ]] || { echo "postgresql+asyncpg://USER:PASSWORD@HOST:5432/aurex" > "secrets/$f"; echo "edit secrets/$f"; }  # pragma: allowlist secret
done
# Optional real US stock/ETF data: paste your Alpaca key ID and secret into these files (left empty = simulated).
for f in alpaca_key_id alpaca_secret_key; do [[ -e "secrets/$f" ]] || : > "secrets/$f"; done
echo "secrets ready in $(pwd)/secrets (never commit this directory)"
