"""Scenario schema + loader.

Plain dataclasses and a hand-written loader, deliberately not pydantic —
see docs/evaluation.md for why. A scenario is one JSON file under
evals/scenarios/; fixture data can be inlined or referenced via
{"$ref": "<file under evals/fixtures/data/>"} to avoid duplicating large
canned datasets across scenario files.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SCENARIOS_DIR = Path(__file__).resolve().parent / "scenarios"
FIXTURE_DATA_DIR = Path(__file__).resolve().parent / "fixtures" / "data"

VALID_KINDS = {"agentic", "approval_only", "code_invariant", "golden_trace"}


@dataclass
class Scenario:
    id: str
    kind: str
    description: str
    trials: int = 1
    # Included in the smoke suite's small representative agentic subset.
    # Ignored for non-agentic kinds, which always run in both suites since
    # they're free/cheap. See docs/evaluation.md.
    smoke: bool = False

    # agentic / approval_only
    question: str | None = None
    fixtures: dict | None = None
    project_registry: dict | None = None
    approval_policy: str = "none"
    proposed_action: dict | None = None
    expected_tools: list[str] = field(default_factory=list)
    forbidden_tools: list[str] = field(default_factory=list)
    max_tool_calls: int | None = None
    required_evidence_sources: list[str] = field(default_factory=list)
    expected_conclusion: str | None = None
    # Verbatim, for adversarial_robustness judge prompts only — the actual
    # fixture Slack data (not this field) is what the agent actually sees.
    injected_instruction: str | None = None
    safety_invariants: list[str] = field(default_factory=list)
    graders: list[str] = field(default_factory=list)

    # code_invariant
    delegate_file: str | None = None
    delegate_test: str | None = None

    # golden_trace
    golden_trace_file: str | None = None

    def validate(self) -> None:
        if self.kind not in VALID_KINDS:
            raise ValueError(f"{self.id}: unknown kind {self.kind!r}")
        if self.kind in ("agentic",) and not self.question:
            raise ValueError(f"{self.id}: kind=agentic requires 'question'")
        if self.kind == "approval_only" and not self.proposed_action:
            raise ValueError(f"{self.id}: kind=approval_only requires 'proposed_action'")
        if self.kind == "code_invariant" and not (self.delegate_file and self.delegate_test):
            raise ValueError(f"{self.id}: kind=code_invariant requires 'delegate_file' and 'delegate_test'")
        if self.kind == "golden_trace" and not self.golden_trace_file:
            raise ValueError(f"{self.id}: kind=golden_trace requires 'golden_trace_file'")


def _resolve_refs(value):
    """Recursively replaces {"$ref": "<name>.json"} with the referenced file's parsed content."""
    if isinstance(value, dict):
        if set(value.keys()) == {"$ref"}:
            ref_path = FIXTURE_DATA_DIR / value["$ref"]
            with open(ref_path) as f:
                return _resolve_refs(json.load(f))
        return {k: _resolve_refs(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_resolve_refs(v) for v in value]
    return value


def load_scenario(path: Path) -> Scenario:
    with open(path) as f:
        raw = json.load(f)

    raw = dict(raw)
    if "fixtures" in raw and raw["fixtures"] is not None:
        raw["fixtures"] = _resolve_refs(raw["fixtures"])

    known_fields = {f.name for f in Scenario.__dataclass_fields__.values()}
    unknown = set(raw.keys()) - known_fields
    if unknown:
        raise ValueError(f"{path.name}: unknown scenario field(s): {sorted(unknown)}")

    scenario = Scenario(**raw)
    scenario.validate()
    return scenario


def load_all_scenarios(directory: Path = SCENARIOS_DIR) -> list[Scenario]:
    scenarios = [load_scenario(p) for p in sorted(directory.glob("*.json"))]
    ids = [s.id for s in scenarios]
    duplicates = {i for i in ids if ids.count(i) > 1}
    if duplicates:
        raise ValueError(f"Duplicate scenario ids: {duplicates}")
    return scenarios
