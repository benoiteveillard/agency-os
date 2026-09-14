"""Aggregation + human-readable table + machine-readable JSON.

Safety-relevant grader failures are never averaged into the Quality
pass-rate table — they're collected separately and reported as raw
incident counts, per the explicit instruction that a single unauthorized
write must not be diluted by a good overall score.
"""

from __future__ import annotations

import json
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path

from runner import ScenarioReport


def _safety_incidents(scenario_reports: list[ScenarioReport]) -> dict[str, list[dict]]:
    incidents: dict[str, list[dict]] = {}
    for sr in scenario_reports:
        for trial in sr.trials:
            for g in trial.grader_results:
                if g.safety_relevant and not g.passed:
                    incidents.setdefault(g.grader, []).append(
                        {
                            "scenario": sr.scenario.id,
                            "trial": trial.trial_index,
                            "trace_id": trial.trace_id,
                            "detail": g.detail,
                        }
                    )
    return incidents


def to_json(scenario_reports: list[ScenarioReport], judge_usage: dict, suite: str, started_at: str) -> dict:
    return {
        "suite": suite,
        "started_at": started_at,
        "finished_at": datetime.now(timezone.utc).isoformat(),
        "judge_usage": judge_usage,
        "scenarios": [
            {
                "id": sr.scenario.id,
                "kind": sr.scenario.kind,
                "description": sr.scenario.description,
                "skipped": sr.skipped,
                "skip_reason": sr.skip_reason,
                "pass_count": sr.pass_count,
                "trial_count": sr.trial_count,
                "trials": [
                    {
                        "trial_index": t.trial_index,
                        "passed": t.passed,
                        "harness_ok": t.harness_ok,
                        "run_id": t.run_id,
                        "trace_id": t.trace_id,
                        "wall_time_s": round(t.wall_time_s, 2),
                        "error": t.error,
                        "graders": [asdict(g) for g in t.grader_results],
                    }
                    for t in sr.trials
                ],
            }
            for sr in scenario_reports
        ],
        "safety_incidents": _safety_incidents(scenario_reports),
    }


def to_human_readable(scenario_reports: list[ScenarioReport], judge_usage: dict, suite: str) -> str:
    lines: list[str] = []
    lines.append(f"Suite: {suite}")
    lines.append("")
    lines.append(f"{'Scenario':<38} {'Kind':<16} Pass rate")
    lines.append("-" * 70)

    for sr in scenario_reports:
        if sr.skipped:
            lines.append(f"{sr.scenario.id:<38} {sr.scenario.kind:<16} SKIPPED ({sr.skip_reason})")
            continue
        rate = f"{sr.pass_count}/{sr.trial_count}"
        lines.append(f"{sr.scenario.id:<38} {sr.scenario.kind:<16} {rate}")
        for t in sr.trials:
            if not t.passed:
                failed_graders = [g.grader for g in t.grader_results if not g.passed]
                if not t.harness_ok:
                    failed_graders = ["harness_error"] + failed_graders
                lines.append(
                    f"    trial {t.trial_index} FAILED [{', '.join(failed_graders)}]"
                    f" — trace {t.trace_id or 'n/a'} (run_id={t.run_id or 'n/a'})"
                )

    incidents = _safety_incidents(scenario_reports)
    lines.append("")
    lines.append("Safety")
    lines.append("-" * 70)
    if not incidents:
        lines.append("No safety incidents detected.")
    else:
        for grader_name, hits in incidents.items():
            lines.append(f"{grader_name:<38} {len(hits)}")
            for hit in hits:
                lines.append(
                    f"    -> {hit['scenario']} trial {hit['trial']} (trace {hit['trace_id']}): {hit['detail']}"
                )

    lines.append("")
    lines.append(
        f"LLM judge usage: {judge_usage['calls']} call(s), "
        f"{judge_usage['input_tokens']} input tokens, {judge_usage['output_tokens']} output tokens"
    )
    return "\n".join(lines)


def write_json(report: dict, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, indent=2))
