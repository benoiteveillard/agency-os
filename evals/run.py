#!/usr/bin/env python3
"""agency-os Phase 5 evaluation runner.

Usage:
    python evals/run.py --suite smoke   # fast local feedback
    python evals/run.py --suite full    # the full configured scenario/trial suite
    python evals/run.py --live          # small, read-only live integration suite

See docs/evaluation.md for the full design.
"""

from __future__ import annotations

import argparse
import sys
from datetime import datetime, timezone
from pathlib import Path

from connectivity import ConnectivityReport, run_connectivity_check
from env import load_dotenv
from judge import usage as judge_usage
from live_suite import LIVE_SCENARIOS
from report import to_human_readable, to_json, write_json
from runner import ScenarioReport, run_scenario
from scenario import REPO_ROOT, Scenario, load_all_scenarios

RESULTS_DIR = REPO_ROOT / "evals" / "results"


def scenarios_for_suite(scenarios: list[Scenario], suite: str) -> list[Scenario]:
    if suite == "full":
        return scenarios
    # smoke: every deterministic/code-invariant/golden-trace/approval-only
    # scenario (cheap), plus only the agentic scenarios explicitly flagged
    # smoke=true — never the whole agentic set.
    return [s for s in scenarios if s.kind != "agentic" or s.smoke]


def trial_count_for(scenario: Scenario, suite: str) -> int:
    if suite == "smoke" and scenario.kind == "agentic":
        return 1  # smoke never repeats a semantic trial; the scenario file's configured count stays untouched
    return scenario.trials


def print_connectivity_report(conn: ConnectivityReport) -> None:
    print("Live connectivity")
    print("-" * 70)
    labels = {"linear": "Linear MCP", "github": "GitHub API", "slack": "Slack API", "anthropic": "Anthropic API"}
    for name, label in labels.items():
        result = getattr(conn, name)
        status = "PASS" if result.get("ok") else f"FAIL — {result.get('error', 'unknown error')}"
        print(f"{label:<20} {status}")
    print()


def run_live_suite() -> tuple[list[ScenarioReport], ConnectivityReport]:
    conn = run_connectivity_check()
    print_connectivity_report(conn)

    print("Full live agent flow")
    print("-" * 70)
    if not conn.anthropic.get("ok"):
        reason = f"BLOCKED: Anthropic unavailable ({conn.anthropic.get('error', 'unknown error')})"
        print(f"{reason} — {len(LIVE_SCENARIOS)} scenario(s) not attempted\n")
        reports = [ScenarioReport(s, skipped=True, skip_reason=reason) for s in LIVE_SCENARIOS]
        return reports, conn

    reports = []
    for scenario in LIVE_SCENARIOS:
        print(f"Running {scenario.id} (agentic, 1 trial(s))...", file=sys.stderr)
        reports.append(run_scenario(scenario, 1, "live"))
    return reports, conn


def main() -> None:
    load_dotenv()
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--suite", choices=["smoke", "full"], help="run the fixture-backed scenario suite")
    parser.add_argument("--live", action="store_true", help="run the small live integration suite")
    parser.add_argument("--scenario", help="run only this scenario id (fixture suites only)")
    args = parser.parse_args()

    if bool(args.suite) == bool(args.live):
        parser.error("pass exactly one of --suite {smoke,full} or --live")

    started_at = datetime.now(timezone.utc).isoformat()
    connectivity: ConnectivityReport | None = None

    if args.live:
        suite_name = "live"
        reports, connectivity = run_live_suite()
    else:
        suite_name = args.suite
        mode = "fixture"
        all_scenarios = load_all_scenarios()
        if args.scenario:
            scenarios = [s for s in all_scenarios if s.id == args.scenario]
            if not scenarios:
                parser.error(f"unknown scenario id: {args.scenario}")
        else:
            scenarios = scenarios_for_suite(all_scenarios, args.suite)

        reports = []
        for scenario in scenarios:
            trial_count = trial_count_for(scenario, suite_name)
            print(f"Running {scenario.id} ({scenario.kind}, {trial_count} trial(s))...", file=sys.stderr)
            reports.append(run_scenario(scenario, trial_count, mode))

    usage = judge_usage()
    print()
    print(to_human_readable(reports, usage, suite_name))

    json_report = to_json(reports, usage, suite_name, started_at)
    if connectivity is not None:
        json_report["connectivity"] = {
            "linear": connectivity.linear,
            "github": connectivity.github,
            "slack": connectivity.slack,
            "anthropic": connectivity.anthropic,
        }
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    out_path: Path = RESULTS_DIR / f"{suite_name}-{timestamp}.json"
    write_json(json_report, out_path)
    print(f"\nJSON report written to {out_path.relative_to(REPO_ROOT)}", file=sys.stderr)

    sys.exit(1 if json_report["safety_incidents"] else 0)


if __name__ == "__main__":
    main()
