"""Concept-drift monitoring: Population Stability Index (PSI) of every feature between
the training reference and a recent window, plus calibration decay on recent labels.

PSI < 0.10 stable · 0.10-0.25 moderate shift · > 0.25 significant shift.
Status: "drift" when ≥ 2 features exceed 0.25 or the recent Brier score is > 20% worse
than out-of-sample; "warning" when any feature exceeds 0.10; otherwise "ok".
"""

from typing import Any

import numpy as np

from app.ml.features import FEATURES

EPS = 1e-4


def reference(X: np.ndarray) -> dict[str, Any]:
    out = {}
    for j, name in enumerate(FEATURES):
        edges = np.unique(np.quantile(X[:, j], np.linspace(0.1, 0.9, 9)))
        props = np.bincount(np.searchsorted(edges, X[:, j], side="right"), minlength=len(edges) + 1) / len(X)
        out[name] = {"edges": [float(e) for e in edges], "expected": [float(p) for p in props],
                     "mean": float(X[:, j].mean()), "std": float(X[:, j].std())}
    return out


def psi(ref: dict[str, Any], X: np.ndarray) -> dict[str, float]:
    out = {}
    for j, name in enumerate(FEATURES):
        r = ref[name]
        edges = np.asarray(r["edges"])
        exp = np.clip(np.asarray(r["expected"]), EPS, None)
        act = np.bincount(np.searchsorted(edges, X[:, j], side="right"), minlength=len(edges) + 1) / max(1, len(X))
        act = np.clip(act, EPS, None)
        out[name] = round(float(np.sum((act - exp) * np.log(act / exp))), 4)
    return out


def assess(psis: dict[str, float], recent_brier: float | None, oos_brier: float) -> dict[str, Any]:
    severe = [k for k, v in psis.items() if v > 0.25]
    moderate = [k for k, v in psis.items() if 0.10 < v <= 0.25]
    decay = None if recent_brier is None else (recent_brier - oos_brier) / oos_brier
    reasons = []
    if len(severe) >= 2:
        reasons.append(f"significant shift in {len(severe)} features ({', '.join(severe[:4])})")
    if decay is not None and decay > 0.2:
        reasons.append(f"recent Brier score {decay:+.0%} worse than out-of-sample")
    status = "drift" if reasons else "warning" if severe or moderate else "ok"
    if status == "warning":
        reasons.append(f"moderate shift in {len(severe) + len(moderate)} feature(s)")
    return {"status": status, "reasons": reasons, "psi": psis, "max_psi": max(psis.values()) if psis else 0.0,
            "recent_brier": None if recent_brier is None else round(recent_brier, 5),
            "oos_brier": oos_brier, "brier_change": None if decay is None else round(decay, 4)}
