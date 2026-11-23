"""Model zoo. Each entry builds a fresh, unfitted scikit-learn compatible classifier.

Deliberately conservative hyper-parameters (shallow trees, strong regularisation,
large minimum leaf sizes): financial targets are noisy and overfitting is the default
failure mode. Sequence models (LSTM, temporal transformers), HMM regimes and RL are
research items for a later iteration.
"""

from dataclasses import dataclass
from typing import Any

from sklearn.ensemble import RandomForestClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler


@dataclass(frozen=True)
class Algorithm:
    key: str
    label: str
    description: str
    params: dict[str, Any]


ALGORITHMS: dict[str, Algorithm] = {
    "logistic": Algorithm("logistic", "Logistic regression", "Regularised linear baseline (L2, C = 0.5).",
                          {"C": 0.5, "max_iter": 500}),
    "random_forest": Algorithm("random_forest", "Random forest",
                               "200 shallow trees, depth ≤ 5, ≥ 40 samples per leaf.",
                               {"n_estimators": 200, "max_depth": 5, "min_samples_leaf": 40,
                                "n_jobs": 1, "random_state": 7}),
    "lightgbm": Algorithm("lightgbm", "LightGBM", "Gradient boosting, 15 leaves, ≥ 50 samples per leaf, "
                          "row/feature subsampling.",
                          {"n_estimators": 200, "learning_rate": 0.03, "num_leaves": 15,
                           "min_child_samples": 50, "subsample": 0.8, "subsample_freq": 1,
                           "colsample_bytree": 0.8, "reg_lambda": 1.0, "random_state": 7,
                           "verbose": -1, "n_jobs": 1}),
}


def make_model(key: str):
    a = ALGORITHMS[key]
    if key == "logistic":
        return make_pipeline(StandardScaler(), LogisticRegression(**a.params))
    if key == "random_forest":
        return RandomForestClassifier(**a.params)
    if key == "lightgbm":
        from lightgbm import LGBMClassifier
        return LGBMClassifier(**a.params)
    raise KeyError(key)


def feature_importance(model, names: list[str]) -> dict[str, float]:
    est = model[-1] if hasattr(model, "steps") else model
    if hasattr(est, "coef_"):
        raw = [abs(float(v)) for v in est.coef_[0]]
    elif hasattr(est, "feature_importances_"):
        raw = [float(v) for v in est.feature_importances_]
    else:
        return {}
    total = sum(raw) or 1.0
    return dict(sorted(((n, round(v / total, 4)) for n, v in zip(names, raw, strict=True)),
                       key=lambda kv: -kv[1]))
