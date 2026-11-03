"""Orchestrates one scenario's trials: builds the eval-runner config,
invokes the subprocess bridge, runs the requested graders, and aggregates
into a ScenarioReport. See eval_runner_bridge.py for the TS boundary and
graders.py for grading logic.
"""

from __future__ import annotations

import os
import uuid
from dataclasses import dataclass, field

from code_invariants import run_code_invariant
from eval_runner_bridge import load_trace, run_eval_runner
from golden_trace import load_golden
from graders import (
    GRADER_FUNCTIONS,
    GraderResult,
    grade_max_tokens_safe_failure,
    grade_trace_integrity,
)
from judge import usage as judge_usage
from scenario import Scenario

DEFAULT_FIXTURE_PROJECT_REGISTRY = {
    "acme-website-migration": {
        "displayName": "Acme Website Migration",
        "linearProjectId": "fixture-project-id",
        "linearTeamId": "fixture-team-id",
        "githubOwner": "fixture-org",
        "githubRepo": "fixture-repo",
        "slackChannelId": "fixture-channel",
    }
}

# The Monday of the launch week every fixture is written around (they target Friday
# 2026-09-18). The agent is told today's date, so without a fixed clock these
# scenarios would drift as real time passes: once the target is in the past, "on
# track" stops being the right answer. Live mode keeps the real date.
FIXTURE_NOW = "2026-09-14T12:00:00Z"

JUDGE_GRADERS = {"task_success", "evidence_grounding", "adversarial_robustness", "failure_handling"}


@dataclass
class TrialReport:
    trial_index: int
    passed: bool
    grader_results: list[GraderResult]
    run_id: str | None
    trace_id: str | None
    harness_ok: bool
    wall_time_s: float
    error: str | None = None


@dataclass
class ScenarioReport:
    scenario: Scenario
    trials: list[TrialReport] = field(default_factory=list)
    skipped: bool = False
    skip_reason: str | None = None

    @property
    def trial_count(self) -> int:
        return len(self.trials)

    @property
    def pass_count(self) -> int:
        return sum(1 for t in self.trials if t.passed)


def required_env_vars(scenario: Scenario, mode: str) -> list[str]:
    needed: set[str] = set()
    if scenario.kind == "agentic":
        needed.add("ANTHROPIC_API_KEY")
    if mode == "live":
        needed |= {"ANTHROPIC_API_KEY", "LINEAR_API_KEY", "GITHUB_TOKEN", "SLACK_BOT_TOKEN"}
    if JUDGE_GRADERS & set(scenario.graders):
        needed.add("ANTHROPIC_API_KEY")
    return sorted(needed)


def missing_env_vars(scenario: Scenario, mode: str) -> list[str]:
    return [v for v in required_env_vars(scenario, mode) if not os.environ.get(v)]


def build_eval_runner_config(scenario: Scenario, mode: str, model: str | None = None) -> dict:
    config: dict = {"mode": mode, "approvalPolicy": scenario.approval_policy}
    if model:
        config["model"] = model
    if scenario.question:
        config["question"] = scenario.question
    if scenario.proposed_action:
        config["proposedAction"] = scenario.proposed_action
    if mode == "fixture":
        config["now"] = FIXTURE_NOW
        config["fixtures"] = scenario.fixtures or {}
        config["projectRegistry"] = scenario.project_registry or DEFAULT_FIXTURE_PROJECT_REGISTRY
    return config


def _run_graders(scenario: Scenario, spans: list[dict], run_summary: dict | None) -> list[GraderResult]:
    results = [grade_trace_integrity(spans, run_summary)]
    for name in scenario.graders:
        if name == "trace_integrity":
            continue
        fn = GRADER_FUNCTIONS.get(name)
        if fn is None:
            results.append(GraderResult(name, False, f"unknown grader: {name}"))
            continue
        if name in ("safety_action_integrity", "failure_handling", "action_proposal_completion"):
            results.append(fn(scenario, spans, run_summary))
        elif name == "tool_evidence_quality":
            results.append(fn(scenario, spans))
        else:  # task_success, evidence_grounding, adversarial_robustness, assessment_correctness, injection_containment
            results.append(fn(scenario, run_summary))
    return results


def run_scenario(scenario: Scenario, trial_count: int, mode: str, model: str | None = None) -> ScenarioReport:
    if scenario.kind == "code_invariant":
        result = run_code_invariant(scenario)
        trial = TrialReport(
            trial_index=0,
            passed=result.passed,
            grader_results=[GraderResult("code_invariant", result.passed, result.detail)],
            run_id=None,
            trace_id=None,
            harness_ok=True,
            wall_time_s=0.0,
        )
        return ScenarioReport(scenario, [trial])

    if scenario.kind == "golden_trace":
        spans, run_summary = load_golden(scenario)
        grader_results = [
            grade_trace_integrity(spans, run_summary),
            grade_max_tokens_safe_failure(spans, run_summary),
        ]
        passed = all(g.passed for g in grader_results)
        trial = TrialReport(
            trial_index=0,
            passed=passed,
            grader_results=grader_results,
            run_id=None,
            trace_id=(run_summary or {}).get("traceId"),
            harness_ok=True,
            wall_time_s=0.0,
        )
        return ScenarioReport(scenario, [trial])

    missing = missing_env_vars(scenario, mode)
    if missing:
        return ScenarioReport(
            scenario, skipped=True, skip_reason=f"missing required env var(s): {', '.join(missing)}"
        )

    # agentic / approval_only
    trials: list[TrialReport] = []
    for i in range(trial_count):
        run_id = f"{scenario.id}-{mode}-{i}-{uuid.uuid4().hex[:8]}"
        config = build_eval_runner_config(scenario, mode, model)
        result = run_eval_runner(config, run_id)
        spans, run_summary = load_trace(result.trace_path)
        grader_results = _run_graders(scenario, spans, run_summary)
        passed = result.process_ok and all(g.passed for g in grader_results)
        trials.append(
            TrialReport(
                trial_index=i,
                passed=passed,
                grader_results=grader_results,
                run_id=run_id,
                trace_id=(run_summary or {}).get("traceId"),
                harness_ok=result.process_ok,
                wall_time_s=result.wall_time_s,
                error=None if result.process_ok else (result.stderr or "")[-500:],
            )
        )
    return ScenarioReport(scenario, trials)


__all__ = ["ScenarioReport", "TrialReport", "run_scenario", "judge_usage"]
