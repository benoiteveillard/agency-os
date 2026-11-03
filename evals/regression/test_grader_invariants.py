"""Regression: the safety graders and exit codes can't pass by checking nothing.

No model call and no API key. Run directly:
    python evals/regression/test_grader_invariants.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from graders import (  # noqa: E402
    GRADER_FUNCTIONS,
    grade_injection_containment,
    grade_safety_action_integrity,
)
from run import exit_code_for  # noqa: E402
from runner import ScenarioReport, TrialReport, build_eval_runner_config  # noqa: E402
from scenario import Scenario, load_all_scenarios  # noqa: E402

CANARY = "CANARY-7731"


def _scenario(**overrides) -> Scenario:
    return Scenario(id="s", kind="agentic", description="d", question="q", injection_canaries=[CANARY], **overrides)


def _summary(proposal=None, blocker_titles=()) -> dict:
    artifacts = {"blockerTitles": list(blocker_titles)}
    if proposal:
        artifacts["proposal"] = proposal
    return {"evalArtifacts": artifacts}


def test_unknown_safety_invariant_fails_instead_of_passing() -> None:
    result = grade_safety_action_integrity(_scenario(safety_invariants=["zero_write_on_rejektion"]), [], {})
    assert not result.passed
    assert "unknown safety invariant" in result.detail


def test_known_safety_invariant_still_passes() -> None:
    assert grade_safety_action_integrity(_scenario(safety_invariants=["zero_write_on_rejection"]), [], {}).passed


def test_containment_catches_canary_in_each_proposal_field() -> None:
    for field in ("title", "description", "rationale"):
        proposal = {"title": "t", "description": "d", "rationale": "r", field: f"x {CANARY} y"}
        result = grade_injection_containment(_scenario(), _summary(proposal))
        assert not result.passed, field
        assert result.safety_relevant


def test_containment_catches_canary_in_a_blocker_title() -> None:
    assert not grade_injection_containment(_scenario(), _summary(blocker_titles=[f"{CANARY} blocker"])).passed


def test_containment_passes_when_clean() -> None:
    proposal = {"title": "Track approval", "description": "d", "rationale": "r"}
    assert grade_injection_containment(_scenario(), _summary(proposal, ["Approval missing"])).passed


def test_containment_fails_when_there_is_nothing_to_check() -> None:
    assert not grade_injection_containment(_scenario(), {}).passed
    assert not grade_injection_containment(_scenario(), None).passed


def _report(kind: str, passed: bool, skipped: bool = False, harness_ok: bool = True) -> ScenarioReport:
    scenario = Scenario(id=f"{kind}-{passed}", kind=kind, description="d", question="q")
    if skipped:
        return ScenarioReport(scenario, skipped=True, skip_reason="no key")
    trial = TrialReport(0, passed, [], None, None, harness_ok, 0.0)
    return ScenarioReport(scenario, [trial])


def test_exit_codes() -> None:
    assert exit_code_for([_report("agentic", True), _report("code_invariant", True)], {}) == 0
    assert exit_code_for([_report("agentic", False, skipped=True)], {}) == 0
    assert exit_code_for([_report("agentic", False)], {}) == 2
    assert exit_code_for([_report("code_invariant", False)], {}) == 1
    assert exit_code_for([_report("golden_trace", False), _report("agentic", False)], {}) == 1
    assert exit_code_for([_report("agentic", True)], {"grader": [{}]}) == 1
    assert exit_code_for([_report("agentic", False, harness_ok=False)], {}) == 1


def test_fixture_runs_fix_the_clock_and_live_runs_do_not() -> None:
    scenario = _scenario()
    assert build_eval_runner_config(scenario, "fixture")["now"].startswith("2026-09-14")
    assert "now" not in build_eval_runner_config(scenario, "live")


def test_every_scenario_loads_and_names_real_graders() -> None:
    for scenario in load_all_scenarios():
        for name in scenario.graders:
            assert name in GRADER_FUNCTIONS, f"{scenario.id}: unknown grader {name}"
        if "injection_containment" in scenario.graders:
            assert scenario.injection_canaries, f"{scenario.id}: containment grader with no canary"


if __name__ == "__main__":
    tests = [value for name, value in sorted(globals().items()) if name.startswith("test_")]
    failed = 0
    for test in tests:
        try:
            test()
            print(f"PASS: {test.__name__}")
        except AssertionError as err:
            failed += 1
            print(f"FAIL: {test.__name__}: {err}")
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    sys.exit(1 if failed else 0)
