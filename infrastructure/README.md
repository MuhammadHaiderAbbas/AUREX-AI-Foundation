# Infrastructure

- `deployment/`: the production stack (`docker-compose.prod.yml`), its env template and
  `make-secrets.sh`. Guide: `docs/operations/deployment.md`.
- `monitoring/`: Prometheus scrape config, alert rules and Grafana provisioning and dashboard.
  `backend/tests/test_monitoring_config.py` checks them against the exported metrics.
- Backup, restore and drill scripts live with the backend (`backend/ops/backup/`) because they
  call the application CLI and ship in the `ops` image.
- The service Dockerfiles live next to their code (`backend/Dockerfile`, `frontend/Dockerfile`).
