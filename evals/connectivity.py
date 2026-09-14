"""Independent per-integration connectivity checks for `--live`.

Runs apps/eval-runner in a standalone diagnostic mode (`--connectivity`) —
four fully independent checks (Linear MCP, GitHub, Slack, Anthropic), each
using the narrowest existing read operation, no model tool loop, no trace
file. This exists so one unavailable provider (e.g. Anthropic out of
credits) cannot make unrelated integrations appear to have failed — see
docs/evaluation.md.
"""

from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass, field

from eval_runner_bridge import EVAL_RUNNER_ENTRY, REPO_ROOT

TIMEOUT_SECONDS = 60
_UNAVAILABLE = {"ok": False, "error": "connectivity check produced no output"}


@dataclass
class ConnectivityReport:
    anthropic: dict = field(default_factory=lambda: dict(_UNAVAILABLE))
    linear: dict = field(default_factory=lambda: dict(_UNAVAILABLE))
    github: dict = field(default_factory=lambda: dict(_UNAVAILABLE))
    slack: dict = field(default_factory=lambda: dict(_UNAVAILABLE))
    harness_ok: bool = False


def run_connectivity_check() -> ConnectivityReport:
    try:
        proc = subprocess.run(
            ["node", "--import", "tsx", str(EVAL_RUNNER_ENTRY), "--connectivity"],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
            timeout=TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired:
        timeout = {"ok": False, "error": f"connectivity check timed out after {TIMEOUT_SECONDS}s"}
        return ConnectivityReport(anthropic=timeout, linear=timeout, github=timeout, slack=timeout, harness_ok=False)

    # dotenv prints an informational banner line to stdout before our JSON
    # (seen consistently across every eval-runner invocation this session)
    # — the JSON is always the last non-empty line, via console.log.
    lines = [line for line in proc.stdout.splitlines() if line.strip()]
    if not lines:
        failure = {"ok": False, "error": (proc.stderr or "no stdout output")[:200]}
        return ConnectivityReport(anthropic=failure, linear=failure, github=failure, slack=failure, harness_ok=False)

    try:
        data = json.loads(lines[-1])
    except json.JSONDecodeError:
        failure = {"ok": False, "error": f"unparseable connectivity output: {lines[-1][:200]!r}"}
        return ConnectivityReport(anthropic=failure, linear=failure, github=failure, slack=failure, harness_ok=False)

    return ConnectivityReport(
        anthropic=data.get("anthropic", dict(_UNAVAILABLE)),
        linear=data.get("linear", dict(_UNAVAILABLE)),
        github=data.get("github", dict(_UNAVAILABLE)),
        slack=data.get("slack", dict(_UNAVAILABLE)),
        harness_ok=proc.returncode == 0,
    )
