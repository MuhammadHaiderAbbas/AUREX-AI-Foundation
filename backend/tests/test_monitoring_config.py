"""The monitoring configuration only refers to metrics the API actually exports."""

import json
import re
from pathlib import Path

import yaml

from app.ops.metrics import registry

MON = Path(__file__).resolve().parents[2] / "infrastructure" / "monitoring"


def exported() -> set[str]:
    names = set()
    for metric in registry.collect():
        names.add(metric.name)
        if metric.type == "counter":
            names.add(f"{metric.name}_total")
        if metric.type == "histogram":
            names.update(f"{metric.name}_{suffix}" for suffix in ("bucket", "count", "sum"))
    return names


def referenced(expr: str) -> set[str]:
    return set(re.findall(r"\b(aurex_[a-z_]+)", expr))


def test_alert_rules_are_well_formed_and_use_real_metrics():
    rules = yaml.safe_load((MON / "alerts.yml").read_text())
    names, seen = exported(), set()
    for group in rules["groups"]:
        for rule in group["rules"]:
            assert rule["alert"].startswith("Aurex") and rule["expr"].strip() and rule["annotations"]["summary"]
            assert rule["labels"]["severity"] in {"page", "ticket", "info"}
            missing = referenced(rule["expr"]) - names
            assert not missing, f"{rule['alert']} uses unknown metrics {missing}"
            seen |= referenced(rule["expr"])
    assert {"aurex_worker_heartbeat_age_seconds", "aurex_last_backup_age_seconds", "aurex_last_anchor_age_seconds"} <= seen


def test_dashboard_uses_real_metrics():
    dash = json.loads((MON / "grafana" / "dashboards" / "aurex-overview.json").read_text())
    names = exported()
    for panel in dash["panels"]:
        for t in panel["targets"]:
            assert not (referenced(t["expr"]) - names), (panel["title"], t["expr"])


def test_prometheus_scrapes_with_the_token():
    cfg = yaml.safe_load((MON / "prometheus.yml").read_text())
    job = cfg["scrape_configs"][0]
    assert job["metrics_path"] == "/metrics" and job["authorization"]["credentials_file"]
