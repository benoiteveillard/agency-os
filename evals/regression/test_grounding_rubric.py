"""Regression: the evidence_grounding rubric must distinguish vague Slack
sentiment from an attributable, factual report of explicit approval.

The bug this guards against: rev 1 of GROUNDING_RUBRIC's approval item said
"avoid treating Slack sentiment or opinion as formal approval" with no
distinction — the judge applied it to ANY Slack-sourced approval claim,
including a specific, attributable, factual report ("the client sent
written sign-off"), penalizing the agent for correctly following
packages/agent/src/prompts.ts's own evidence bar. The rule is
"Slack sentiment != formal approval", not "Slack can never convey an
approval fact". See docs/evaluation.md.

Needs ANTHROPIC_API_KEY (makes 2 real judge calls). Run directly:
    python evals/regression/test_grounding_rubric.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from env import load_dotenv  # noqa: E402

load_dotenv()

import judge  # noqa: E402
from graders import GROUNDING_RUBRIC  # noqa: E402

VAGUE_SENTIMENT_ANSWER = (
    "Yes, the client is happy with the checkout experience — Tom said it looks good and gave "
    "it a thumbs up in Slack, so we should be all set on approval."
)

ATTRIBUTABLE_FACT_ANSWER = (
    'Yes — the client has formally approved the checkout experience. Emma Wilson reported in '
    'Slack: "client sent written sign-off on the checkout experience this morning, attached to '
    'the project doc." This is an attributable, factual report of explicit written approval, '
    "not just positive sentiment."
)

CONTEXT = "Question: Has the client formally approved the checkout experience?"


def _approval_item() -> str:
    for item in GROUNDING_RUBRIC:
        if "sentiment" in item.lower() and "approval" in item.lower():
            return item
    raise AssertionError("no rubric item about Slack sentiment vs formal approval found — did GROUNDING_RUBRIC change shape?")


def main() -> None:
    item = _approval_item()

    vague_scores = judge.rubric_score(GROUNDING_RUBRIC, CONTEXT, VAGUE_SENTIMENT_ANSWER)
    fact_scores = judge.rubric_score(GROUNDING_RUBRIC, CONTEXT, ATTRIBUTABLE_FACT_ANSWER)

    assert item in vague_scores, f"judge response unparsable for the vague-sentiment case: {vague_scores!r}"
    assert item in fact_scores, f"judge response unparsable for the attributable-fact case: {fact_scores!r}"

    assert vague_scores[item] is False, (
        "rubric must flag vague Slack sentiment ('looks good', a thumbs up) as NOT sufficient for formal "
        f"approval — got {vague_scores[item]!r}"
    )
    assert fact_scores[item] is True, (
        "rubric must NOT penalize an attributable, factual report of explicit approval ('client sent "
        f"written sign-off') — got {fact_scores[item]!r}. Slack sentiment != formal approval, but Slack "
        "is not incapable of reporting a fact."
    )

    print("PASS: rubric distinguishes vague Slack sentiment from an attributable approval fact")
    print(f"  vague sentiment    -> {vague_scores[item]}")
    print(f"  attributable fact  -> {fact_scores[item]}")


if __name__ == "__main__":
    main()
