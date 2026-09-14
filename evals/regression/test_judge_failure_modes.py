"""Regression: an empty/unparseable judge response must never be
interpreted as a pass or as "no compromise detected".

Monkeypatches judge._call so this runs with no real API call and no
ANTHROPIC_API_KEY — fast, free, always runnable. The bug this guards
against: claude-sonnet-5 emits an unrequested "thinking" block by default,
which used to be able to consume the entire max_tokens budget before any
answer text, leaving the judge's raw response empty. See
docs/evaluation.md and docs/failures.md.

Run directly:
    python evals/regression/test_judge_failure_modes.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import judge  # noqa: E402


def test_injection_compliance_returns_error_on_empty_response() -> None:
    judge._call = lambda prompt, max_tokens: ""  # type: ignore[method-assign]
    result = judge.injection_compliance_check("some answer", "some injected instruction")
    assert result == "error", f"expected 'error' for an empty judge response, got {result!r}"


def test_injection_compliance_returns_error_on_garbage_response() -> None:
    judge._call = lambda prompt, max_tokens: "I cannot determine this from the given context."  # type: ignore[method-assign]
    result = judge.injection_compliance_check("some answer", "some injected instruction")
    assert result == "error", f"expected 'error' for an unparseable judge response, got {result!r}"


def test_injection_compliance_still_recognizes_yes_and_no() -> None:
    judge._call = lambda prompt, max_tokens: "Yes, it did."  # type: ignore[method-assign]
    assert judge.injection_compliance_check("a", "b") == "yes"
    judge._call = lambda prompt, max_tokens: "No."  # type: ignore[method-assign]
    assert judge.injection_compliance_check("a", "b") == "no"


def test_rubric_score_returns_empty_on_unparseable_response() -> None:
    judge._call = lambda prompt, max_tokens: "not json at all"  # type: ignore[method-assign]
    scores = judge.rubric_score(["item a", "item b"], "context", "answer")
    assert scores == {}, f"expected an empty dict for an unparseable rubric response, got {scores!r}"
    # graders.py's pass condition requires len(scores) == len(rubric_items) — an
    # empty dict can never satisfy that, so this can never silently pass.


def test_rubric_score_returns_empty_on_empty_response() -> None:
    judge._call = lambda prompt, max_tokens: ""  # type: ignore[method-assign]
    scores = judge.rubric_score(["item a"], "context", "answer")
    assert scores == {}, f"expected an empty dict for an empty rubric response, got {scores!r}"


def test_classify_conclusion_falls_back_to_other_on_empty_response() -> None:
    judge._call = lambda prompt, max_tokens: ""  # type: ignore[method-assign]
    label = judge.classify_conclusion("q", "a")
    assert label == "other", f"expected 'other' fallback for an empty response, got {label!r}"
    # "other" never equals a real expected_conclusion, so task_success can
    # never silently pass on a truncated/empty judge response either.


def main() -> None:
    tests = [(name, fn) for name, fn in list(globals().items()) if name.startswith("test_")]
    for name, fn in tests:
        fn()
        print(f"PASS: {name}")
    print(f"\n{len(tests)}/{len(tests)} passed")


if __name__ == "__main__":
    main()
