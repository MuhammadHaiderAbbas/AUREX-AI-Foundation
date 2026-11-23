# Quantitative models (Phase 6)

```
history (backfilled candles) ─► leak-free features ─► purged walk-forward (5 folds) ─► 9 gates
                                                     │ model vs buy&hold, momentum,     │
                                                     │ climatology, after costs         ▼
                                     final fit on all data ─► registry: candidate ──(admin, all gates)──► champion
                                                                                    ▲                      │
                                                     drift check (PSI + Brier decay) ┘    ML agent reads champion
                                                     drift ⇒ eligible = false (never auto-retrain/promote)
```

## Features (14, hourly)
Log returns (1, 4 and 24 bars), 24- and 72-bar volatility and their ratio, RSI, MACD
histogram and SMA20−SMA50 (both in ATRs), Bollinger %B, 24-bar efficiency ratio, distance
from the 72-bar high, and hour of day (sin/cos).

Every feature at row *t* uses only bars ≤ *t*; a test perturbs future bars and checks that
past features don't change. The label is the sign of the forward return over *H* bars.

## Models
| Key | Model | Notes |
|---|---|---|
| `logistic` | Standardised L2 logistic regression | Linear baseline |
| `random_forest` | 200 trees, depth ≤ 5, ≥ 40 samples per leaf | Conservative |
| `lightgbm` | 200 rounds, 15 leaves, ≥ 50 samples per leaf, subsampling | Gradient boosting |

LSTM and temporal transformers, HMM regimes and RL are research items for later; they must
beat these models out of sample before being added.

## Validation
Five expanding folds. Each training set ends **H bars before** its test block (the purge),
so overlapping labels can't leak. Test decisions are made every *H* bars (non-overlapping).
The strategy is long when P(up) > 0.55, otherwise flat (spot, no shorting), and pays a
per-side cost (crypto 11 bps, FX 1, shares 6, ETFs 4).

The same test points are scored for buy & hold, momentum and climatology baselines.
Metrics: accuracy, AUC, Brier, log loss, ECE with a reliability table, net return, Sharpe,
max drawdown, trades, exposure, hit rate, per-fold results, and downsampled equity curves.

## Promotion gates (all required)
1. Beats buy & hold after costs.
2. Beats the momentum baseline after costs.
3. Brier score below climatology.
4. ECE < 0.08.
5. Sharpe > 0.5.
6. At least 20 out-of-sample trades.
7. Beats buy & hold in ≥ 60% of folds.
8. **Plausible performance:** Sharpe ≤ 4 and AUC ≤ 0.75. Anything stronger on financial
   returns almost always means leakage or a non-market data source.
9. **Trained on real market data:** not synthetic.

Promotion is an audited **admin action**, at most one champion per instrument (enforced by a
partial unique index). The previous champion is retired.

## Drift monitoring
`POST /ml/versions/{id}/drift-check` compares 30 recent days with the training reference.
It computes the PSI per feature (decile bins) and the recent Brier score against the
out-of-sample Brier.

The result is `drift` when ≥ 2 features have PSI > 0.25 or Brier is > 20% worse;
`warning` when any feature has PSI > 0.10; otherwise `ok`. Drift on a champion sets
`eligible = false`: the ML agent abstains and nothing is retrained or replaced
automatically. An administrator trains a candidate, compares it and promotes it.

## Artifacts
Fitted models are stored in the database with a SHA-256 hash, which is checked before every
load; a mismatch makes the ML agent abstain. The ML agent has **zero vote weight** until an
administrator assigns it.

## Synthetic data
The default data source is a deterministic generator made of smooth cycles, so models reach
AUC around 0.9 and very high Sharpe on it. That proves the pipeline runs end to end, not
that there is a trading edge. Gates 8 and 9 make such versions impossible to promote.
