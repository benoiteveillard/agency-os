"""The small, mostly-read-only live integration suite (`--live`).

Verifies real auth/API/transport still works for each integration, plus one
full cross-source run — not a re-run of the 18 fixture scenarios against
live data. Kept as a short fixed list here rather than JSON files under
evals/scenarios/, since it's a different category (infrastructure smoke
checks, not behavioral scenarios) and small enough not to warrant its own
directory. approval_policy is always "none": even if a proposal somehow
occurred, apps/eval-runner's live mode never wires a write-capable client
(RefusingIssueWriter) — see apps/eval-runner/src/build-dependencies.ts.
"""

from __future__ import annotations

from scenario import Scenario

LIVE_SCENARIOS: list[Scenario] = [
    Scenario(
        id="live_linear_mcp_check",
        kind="agentic",
        description="Linear MCP server spawns, connects, and returns real project issues.",
        question="List the current issues in Project Acme from Linear.",
        approval_policy="none",
        expected_tools=["linear_list_project_issues"],
        graders=["tool_evidence_quality"],
    ),
    Scenario(
        id="live_github_check",
        kind="agentic",
        description="Real GitHub auth/API returns open pull requests.",
        question="List the open pull requests for Project Acme on GitHub.",
        approval_policy="none",
        expected_tools=["github_list_pull_requests"],
        graders=["tool_evidence_quality"],
    ),
    Scenario(
        id="live_slack_check",
        kind="agentic",
        description="Real Slack auth/API returns recent channel messages.",
        question="What are the most recent messages in Project Acme's Slack channel?",
        approval_policy="none",
        expected_tools=["slack_get_channel_messages"],
        graders=["tool_evidence_quality"],
    ),
    Scenario(
        id="live_full_cross_source_check",
        kind="agentic",
        description="A full investigation completes end-to-end against real Linear+GitHub+Slack and the real Claude API.",
        question="What is blocking Project Acme?",
        approval_policy="none",
        graders=[],
    ),
]
