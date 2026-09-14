"""Subprocess bridge to apps/eval-runner (TypeScript).

Python never reimplements the agent — it writes a small JSON config,
invokes the real production investigate()/reviewAndExecute() code path as a
subprocess, and reads back the trace artifact that process writes. Invoked
directly via `node --import tsx` (bypassing `pnpm run`) since this runs once
per trial and pnpm's workspace-resolution overhead adds up across dozens of
trials.
"""

from __future__ import annotations

import json
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
EVAL_RUNNER_ENTRY = REPO_ROOT / "apps" / "eval-runner" / "src" / "index.ts"
RUNS_DIR = REPO_ROOT / "evals" / "runs"

TRIAL_TIMEOUT_SECONDS = 180


@dataclass
class TrialRunResult:
    run_id: str
    process_ok: bool  # subprocess exited 0 — a harness-level fact, not a scenario pass/fail
    trace_path: Path
    stderr: str
    wall_time_s: float


def run_eval_runner(config: dict, run_id: str) -> TrialRunResult:
    RUNS_DIR.mkdir(parents=True, exist_ok=True)
    config_path = RUNS_DIR / f"{run_id}.config.json"
    trace_path = RUNS_DIR / f"{run_id}.jsonl"

    config = dict(config)
    config["outputTracePath"] = str(trace_path)
    config_path.write_text(json.dumps(config))

    start = time.monotonic()
    try:
        proc = subprocess.run(
            ["node", "--import", "tsx", str(EVAL_RUNNER_ENTRY), "--config", str(config_path)],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
            timeout=TRIAL_TIMEOUT_SECONDS,
        )
        process_ok = proc.returncode == 0
        stderr = proc.stderr
    except subprocess.TimeoutExpired as exc:
        process_ok = False
        stderr = f"eval-runner timed out after {TRIAL_TIMEOUT_SECONDS}s: {exc}"
    wall_time_s = time.monotonic() - start

    return TrialRunResult(
        run_id=run_id,
        process_ok=process_ok,
        trace_path=trace_path,
        stderr=stderr,
        wall_time_s=wall_time_s,
    )


def load_trace(trace_path: Path) -> tuple[list[dict], dict | None]:
    """Returns (spans, run_summary). run_summary is None if the trace file is missing or incomplete."""
    if not trace_path.exists():
        return [], None
    spans: list[dict] = []
    run_summary: dict | None = None
    with open(trace_path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            entry = json.loads(line)
            if entry.get("type") == "span":
                spans.append(entry)
            elif entry.get("type") == "run_summary":
                run_summary = entry
    return spans, run_summary
