# ML workspace

The production pipeline lives in `backend/app/ml` so the API and agents can import it:

| Module | Purpose |
|---|---|
| `features.py` | Leak-free hourly features and forward-return labels |
| `models.py` | Model zoo: logistic regression, random forest, LightGBM |
| `validation.py` | Purged walk-forward validation, cost-aware strategy metrics, promotion gates |
| `drift.py` | PSI feature drift and calibration-decay assessment |
| `service.py` | Model registry: train, promote (gated, by a human), retire, drift check, inference |

This directory is reserved for offline research notebooks and datasets (not shipped).
See `docs/architecture/models.md`.
