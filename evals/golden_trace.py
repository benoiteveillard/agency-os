"""Loads a committed golden trace fixture for a golden_trace-kind scenario.

No subprocess, no API call — this is the cheapest scenario kind, by
design, since it regresses a fact already captured live. See
docs/evaluation.md for the promotion/sanitization process a golden trace
goes through before being committed.
"""

from __future__ import annotations

from pathlib import Path

from eval_runner_bridge import load_trace
from scenario import REPO_ROOT, Scenario

GOLDEN_DIR = REPO_ROOT / "evals" / "fixtures" / "golden"


def load_golden(scenario: Scenario) -> tuple[list[dict], dict | None]:
    path = GOLDEN_DIR / scenario.golden_trace_file
    if not path.exists():
        raise FileNotFoundError(f"golden_trace_file not found: {path}")
    return load_trace(path)
