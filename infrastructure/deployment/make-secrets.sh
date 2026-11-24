#!/usr/bin/env bash
# Creates ./secrets with random keys (mode 600). Database URLs must be filled in by hand.
# Existing files are never overwritten.
set -euo pipefail
cd "$(dirname "$0")"
umask 077
mkdir -p secrets
rand() { python3 -c 'import secrets; print(secrets.token_urlsafe(48))'; }
for f in jwt_secret data_key artifact_key metrics_token grafana_admin_password redis_password; do
  [[ -s "secrets/$f" ]] || rand > "secrets/$f"
done
[[ -s secrets/redis_url ]] || echo "redis://:$(cat secrets/redis_password)@redis:6379/0" > secrets/redis_url
for f in database_url drill_admin_url; do
  [[ -s "secrets/$f" ]] || { echo "postgresql+asyncpg://USER:PASSWORD@HOST:5432/aurex" > "secrets/$f"; echo "edit secrets/$f"; }  # pragma: allowlist secret
done
echo "secrets ready in $(pwd)/secrets (never commit this directory)"
