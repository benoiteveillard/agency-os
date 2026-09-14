"""Runs a code_invariant scenario by delegating to an existing Vitest test.

These scenarios (digest-mismatch refusal, duplicate-evidence prevention)
are structural safety properties of packages/agent that are already
covered, deterministically, by unit tests — see docs/evaluation.md for why
they're incorporated into this report rather than re-derived end-to-end.
No trace artifact is produced; there's no execution to trace.
"""

from __future__ import annotations

import subprocess
from dataclasses import dataclass

from scenario import REPO_ROOT, Scenario

VITEST_BIN = REPO_ROOT / "node_modules" / ".bin" / "vitest"
TIMEOUT_SECONDS = 60


@dataclass
class CodeInvariantResult:
    passed: bool
    detail: str


def run_code_invariant(scenario: Scenario) -> CodeInvariantResult:
    try:
        proc = subprocess.run(
            [str(VITEST_BIN), "run", scenario.delegate_file, "-t", scenario.delegate_test],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
            timeout=TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired as exc:
        return CodeInvariantResult(passed=False, detail=f"vitest timed out: {exc}")

    passed = proc.returncode == 0
    tail = (proc.stdout + proc.stderr)[-1500:]
    detail = f"delegated to {scenario.delegate_file} -t \"{scenario.delegate_test}\"" if passed else tail
    return CodeInvariantResult(passed=passed, detail=detail)
