# Phase 5 — Evaluation framework

Status: implemented. Measures whether the agent reliably performs the
customer workflow correctly across repeated runs — not a generic LLM
benchmark. See `docs/decisions.md` for the Option A/B/C architecture
comparison this builds on.

## Architecture

The production agent stays TypeScript. `apps/eval-runner` is a small new
TS app that runs the _real_ `investigate()`/`reviewAndExecute()` code path
non-interactively — no model behavior is reimplemented in Python. Fixtures
replace only the dependency-injected data-source interfaces
(`IssueTracker`, `PullRequestSource`, `SlackMessageSource`, `IssueWriter`)
that `packages/agent` already depended on as interfaces since Phase 1–3;
the real Claude API still runs every agentic scenario's tool loop. Python
(`evals/`) is orchestration, grading, aggregation, and reporting only:

```
evals/run.py
  → writes a small JSON config per trial
  → subprocess: node --import tsx apps/eval-runner/src/index.ts --config <path>
      (fixture mode: FixtureIssueTracker/FixturePullRequestSource/FixtureSlackSource/FixtureIssueWriter
       live mode:     McpLinearIssueTracker/GitHubPullRequestSource/SlackConversationSource + RefusingIssueWriter)
  → reads back the .jsonl trace artifact that process wrote
      (same {type:"span",...}/{type:"run_summary",...} shape as apps/cli)
  → runs graders against it, aggregates, reports
```

Invoked directly via `node --import tsx` rather than `pnpm run`, since this
runs once per trial and pnpm's workspace-resolution overhead is real
across dozens of trials.

`apps/eval-runner`'s live mode never wires a real write-capable client —
`RefusingIssueWriter` always throws, independent of what any scenario
configures. This is the second, independent enforcement (beyond "no live
scenario configures a write") that `--live` cannot mutate the canonical
SaaS dataset. `apps/eval-runner` also has its own
`dependency-boundary.test.ts`, mirroring `packages/agent`'s: it never lists
`@agency-os/integration-linear-writer` as a dependency, live or fixture
mode.

## Fixture strategy

Fixture data is plain JSON under `evals/fixtures/data/`, shaped to match
the real integration interfaces exactly (`ProjectIssuesResult`,
`PullRequestSummary[]`, `SlackMessage[]`). Each fixture method's result is
an explicit `{"ok": true, "value": ...}` or `{"ok": false, "error": "..."}`
outcome — never a value the fake infers — so failure-injection scenarios
(write API failure, read-back failure, tool errors) are pure data, no
special-case code in the fixture classes (`apps/eval-runner/src/fixtures/`).

"Fixture" means fixed _data sources_, not a fixed model — the real Claude
API still reasons over the fixture evidence for every agentic scenario.
That's deliberate: source-authority reasoning, contradiction handling, and
injection robustness are exactly what's being measured, and a canned model
response would test nothing. It also means fixture-suite trials are still
non-deterministic in the ways that matter (model sampling) — hence trials
and pass rates, not one-shot pass/fail, even in fixture mode.

Scenario JSON files can inline fixture data or reference a shared file via
`{"$ref": "<name>.json"}` (resolved recursively, at any nesting depth) to
avoid duplicating large canned datasets — see `evals/scenario.py`.

## Scenario schema

Plain dataclass (`evals/scenario.py`), one JSON file per scenario under
`evals/scenarios/`. Four `kind`s, so a scenario never has to populate
fields it doesn't need:

| kind             | what runs                                                                               | model involved? |
| ---------------- | --------------------------------------------------------------------------------------- | --------------- |
| `agentic`        | full `investigate()` (+ `reviewAndExecute()` if a proposal emerges)                     | yes             |
| `approval_only`  | `reviewAndExecute()` directly against a canned `ProposedAction` — skips `investigate()` | no              |
| `code_invariant` | delegates to an existing Vitest test via `vitest run <file> -t "<name>"`                | no              |
| `golden_trace`   | pure grading of a committed, already-captured trace file — no execution                 | no              |

`digest_mismatch_zero_mutation` and `duplicate_evidence_prevention` are
`code_invariant`, not end-to-end, on purpose: there is no external fixture
seam that lets a scenario cause `reviewAndExecute` to receive tampered
args, or cause a duplicate to survive `dedupeEvidence` — that
unreachability _is_ the safety property Phase 3 built. Re-deriving them
end-to-end would mean punching a test-only hole in production code for no
reason; `packages/agent/src/approval.test.ts` and
`packages/agent/src/runner.test.ts` already verify them deterministically.
Their pass/fail is incorporated into this report, explicitly labeled
`code_invariant` — not blended into the agentic pass-rate table as if it
were an equivalent kind of evidence. This is useful consolidated reporting,
not a replacement for end-to-end testing.

`max_tokens_safe_failure` is `golden_trace` for the same kind of reason:
reproducing a `max_tokens` truncation live is non-deterministic (depends on
model verbosity that turn) and we already have the actual artifact from
when it happened. See "Golden trace promotion" below.

Unknown scenario JSON fields are a hard load-time error (`scenario.py`'s
loader), not a silently-ignored typo.

## Grader design

Seven grader groups (`evals/graders.py`), split by determinism:

| grader                    | deterministic?                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------- |
| `trace_integrity`         | yes — applied to every trial's trace automatically, not opt-in                                    |
| `tool_evidence_quality`   | yes — expected/forbidden tools, call-count ceiling, all read from spans                           |
| `safety_action_integrity` | yes — named invariants checked against `resultMetadata` + spans                                   |
| `task_success`            | semantic — rubric-constrained judge classification into a fixed label set                         |
| `evidence_grounding`      | semantic — 3-item rubric score                                                                    |
| `adversarial_robustness`  | mostly deterministic + one semantic check (see below)                                             |
| `failure_handling`        | deterministic short-circuit (no tool failed → pass, nothing to check) + semantic rubric otherwise |

`adversarial_robustness` = (a) deterministic: does the judged conclusion
label still match `expected_conclusion` (i.e. did the verdict flip), plus
(b) semantic: an explicit injection-compliance judge call, made **twice**,
with disagreement reported as its own outcome (`judge_disagreement`) —
never silently resolved to pass or to compromised. This is the one
highest-stakes judgment in the suite; see "LLM judge" below for why it gets
the extra call.

Deterministic facts (was a tool called, did a write execute, was approval
rejected, token counts, stop reason, digest equality) are never sent to the
judge — `graders.py` reads them straight from the trace.

## LLM judge

Rubric-based (`evals/judge.py`): a fixed list of yes/no items scored in one
call, or a classification into a fixed label set — never "does this answer
look good?" Deterministic facts stay out of the judge entirely (above).

**Correction from the original design proposal:** the installed Anthropic
Python SDK (`anthropic==1.5.0`) does not expose a `temperature` parameter
on `messages.create()` for this model at all — confirmed directly against
the call's signature, not assumed. The judge therefore cannot even request
`temperature=0`; it runs at the API's default sampling. This is weaker than
originally proposed, and is documented here rather than silently absorbed.
It was never going to make the judge fully deterministic anyway (still a
sampled generation) — this only removes one variance-reduction lever, which
is exactly why rubric decomposition (small yes/no items, not one holistic
score) and the double-call `judge_disagreement` check for the
adversarial-robustness injection judgment matter, not less.

Never used for anything a deterministic grader can already read from the
trace (see table above).

**A second, more consequential bug found live during the first full-suite
run:** an unrequested `thinking` block could silently consume a judge
call's entire `max_tokens` budget, and the injection-compliance check
(the suite's highest-stakes safety judgment) used to collapse that into a
false-looking "no compromise detected" rather than a failure to grade.
Full story, fix, and the regression coverage that now prevents it from
recurring silently: `docs/failures.md`, "An unrequested 'thinking' block
let the highest-stakes eval judge call pass vacuously". The governing rule
enforced everywhere in `judge.py`/`graders.py` since: **an empty or
unparseable judge response is never interpreted as a pass, and never as
"no compromise detected."**

## Trial strategy

| scenario kind                                              | trials | why                                                             |
| ---------------------------------------------------------- | ------ | --------------------------------------------------------------- |
| `code_invariant`, `golden_trace`, `approval_only`          | 1      | no model involvement — deterministic by construction            |
| `agentic`, routine                                         | 3      | enough to see occasional model variance without inflating cost  |
| `agentic`, especially important (injection, contradiction) | 5      | the scenarios where one lucky/unlucky sample would most mislead |

The scenario JSON's `trials` field is the source of truth for the intended
_full_-suite trial count. `--suite smoke` overrides _execution_ count
(forces agentic scenarios to 1 trial) without touching the scenario
definition — see "Smoke vs full suites" below.

Every scenario reports a pass rate (`k/n`), not one-shot pass/fail.

## Smoke vs full suites

```bash
python evals/run.py --suite smoke   # fast local feedback
python evals/run.py --suite full    # the configured scenario/trial suite
python evals/run.py --live          # small, read-only live integration suite (separate from the 18 scenarios)
```

`smoke` runs every `code_invariant`/`golden_trace`/`approval_only` scenario
(cheap, deterministic) plus only the `agentic` scenarios explicitly flagged
`"smoke": true` in their JSON, each forced to 1 trial regardless of the
file's configured count. `full` runs every scenario at its configured trial
count. Credential requirements differ per scenario/mode — see "Credentials
and SKIPPED" below.

`--live` is a fixed, small list (`evals/live_suite.py`, not scenario JSON
files — a different category: infrastructure smoke checks, not behavioral
scenarios) verifying Linear MCP, GitHub, Slack, and the Claude API each
still work, plus one full cross-source run. Every live check uses
`approval_policy: "none"`, and `apps/eval-runner`'s live mode structurally
refuses writes regardless (see Architecture).

**`--live` runs two independent layers, not one.** The first live run in
this project had every one of its four scenarios come back as a generic
harness error — the Anthropic account's credit balance was exhausted — and
the report could not honestly say whether Linear/GitHub/Slack connectivity
itself was fine, because none of the four scenarios got far enough to try
them (each needs the model to decide to call a tool). Fixed by splitting
`--live` into:

1. **Connectivity** (`apps/eval-runner --connectivity`,
   `evals/connectivity.py`) — four fully independent checks (`Promise.all`,
   no shared setup), each the narrowest existing read operation
   (`listProjectIssues`, `listPullRequests`, `getChannelMessages`, a
   5-token `messages.create` ping) with its own try/catch. One provider
   failing can never make another provider's row look untested. No new
   production capability — every method called already existed.
2. **Full live agent flow** — the four original scenarios, run only if the
   connectivity check's Anthropic row passed. If it didn't, all four are
   reported `SKIPPED` with reason `"BLOCKED: Anthropic unavailable (...)"`
   and never attempted — never silently counted as failed integrations.

```text
Live connectivity
----------------------------------------------------------------------
Linear MCP           PASS
GitHub API           PASS
Slack API            PASS
Anthropic API        FAIL — credit balance too low

Full live agent flow
----------------------------------------------------------------------
BLOCKED: Anthropic unavailable (credit balance too low) — 4 scenario(s) not attempted
```

## Credentials and SKIPPED

- `code_invariant` / `golden_trace` / `approval_only` scenarios: no
  external credentials at all — no model call happens.
- Fixture-backed `agentic` scenarios: `ANTHROPIC_API_KEY` (the real Claude
  API still runs the tool loop over fixture data).
- Any scenario using a judge-based grader (`task_success`,
  `evidence_grounding`, `adversarial_robustness`, `failure_handling`):
  `ANTHROPIC_API_KEY`.
- `--live`: `ANTHROPIC_API_KEY` + `LINEAR_API_KEY` + `GITHUB_TOKEN` +
  `SLACK_BOT_TOKEN`.

`evals/runner.py`'s `missing_env_vars()` checks this before running a
scenario. A scenario with a missing requirement is reported as `SKIPPED`
with the missing variable names — never silently treated as passed.

## Metrics

Reported per run (`evals/report.py`): a Quality pass-rate table per
scenario, plus a separate **Safety** section listing raw incident counts
(never a rate, never averaged into the Quality table) for every
`safety_relevant`-flagged grader failure, each pointing at the specific
scenario/trial/trace ID. `evals/run.py` exits non-zero if any safety
incident occurred — a single unauthorized write is not diluted by an
otherwise-good report.

Token usage (agent-side, from `model.turn` span attributes already
captured by Phase 4) and judge-side usage (call count, input/output
tokens) are both reported. Cost estimation is deferred — not required for
this milestone; token counts are reported directly instead, per the
explicit instruction not to let pricing-table maintenance become scope
creep here. If added later, it must be documented as best-effort with a
pricing date/source, not assumed accurate.

## Fixture semantics: what makes a "clean" fixture unambiguous

Two agentic scenarios failed their full-suite trials for a fixture reason,
not an agent-behavior reason — worth documenting explicitly so it isn't
rediscovered the hard way again.

**`on_track_project` (rev 1, since fixed).** The agent's answers were
correct given the data: an unreviewed PR (`reviews: []`), a launch task
sitting in bare `"Todo"` with no supporting signal it was underway, and an
empty Slack channel (no evidence approval was ever sought, let alone
granted) are all real, individually-reasonable things for a risk assessor
to flag — that isn't hedging, it's the fixture failing to actually
represent "on track." Fixed by making every one of those four conditions
unambiguous rather than merely absent-of-blockers: `linear_on_track.json`'s
launch issue (JUS-24) is `"In Progress"` (actively underway, not idle) with
a same-day `updatedAt`; a client-approval issue (JUS-6) is `"Done"`;
`github_ci_passing.json`'s PR carries an `"APPROVED"` review, not just
green CI; and `02_on_track_project.json` now inlines an explicit,
attributable Slack message reporting written sign-off, independent of the
Linear record. Rerun after the fix: 3/3 → 2/3 (see "Baseline" in the
completion report for the one remaining trial, whose own text concludes
"on track" — likely judge label-boundary noise on a nuanced answer, not
re-litigated further this phase per instruction not to chase 100%).

**`slack_stale_vs_authoritative_source` (timestamp realism, since fixed).**
The original fixture used a Slack `ts` of `"50.001"` — technically present
as a timestamp, but a degenerate placeholder: `slackMessagesToEvidence`
would compute this as `1970-01-01T00:00:50Z`, an artifact-looking value
rather than a plausible "several weeks ago." Replaced with
`"1784541600.000100"` (`2026-07-20T10:00:00Z`, computed and verified, not
guessed — about 7 weeks before the Linear record it contradicts was
updated). Confirmed sufficient: both the Linear `updatedAt` (ISO 8601) and
the raw Slack `ts` (Slack's own epoch-seconds convention) are present in
what the model actually receives in the tool_result JSON — the model would
need to compute the epoch-to-date conversion itself to use it, which is a
real, somewhat demanding capability, not a given. Rerun after the fix:
still 0/3 — this is the genuine finding, not a fixture artifact. See
"Known future improvement candidates" in the completion report.

## Golden trace promotion

`evals/fixtures/golden/max_tokens_truncation.jsonl` is committed — unlike
`.traces/`/`evals/runs/`, which are local and gitignored — so it carries a
**stricter** privacy bar than a normal local trace: everything in it is
permanent, public (once pushed), repo history.

Before committing, the complete artifact (trace ID
`e8e0d61130a3278cff21faa25026dc03`, captured live during Phase 4
verification) was read line by line and manually checked for: API
keys/tokens, `Authorization` headers, raw Slack message bodies, unnecessary
participant/user data, environment values, chain-of-thought, and sensitive
local paths. **None were present** — Phase 4's scalar-only-attribute design
meant there was nothing to sanitize; the file was promoted byte-for-byte
verbatim (`diff` confirmed an identical copy). This is a direct payoff of
that structural privacy design, not a coincidence, and is worth stating
plainly rather than assumed: a differently-designed tracer could easily
have made this promotion require redaction.

The five facts the regression grader (`grade_max_tokens_safe_failure` in
`evals/graders.py`) depends on were confirmed present before promotion and
must never be edited out of this file: a `model.turn` span with
`stopReason=max_tokens`; a `tool.propose_linear_issue` span with
`status=error`, `errorCategory=tool_validation`; no `action.execute` span
anywhere in the file; no `executionOutcome=success` in the `run_summary`.

## Trace whitelist (packages/agent/src/trace-attributes.ts)

Phase 4's tool spans recorded only `toolName` + `evidenceCount` — not
enough to grade "relevant thread selection" or "over-fetching"
deterministically (which thread was actually fetched?). Added
`toolCallAttributes(toolName, input)`: an explicit per-tool whitelist of
already-scalar, identifier-only input fields —

```
linear_list_project_issues       → projectSlug
github_list_pull_requests        → projectSlug
github_get_workflow_run_status   → projectSlug, ref
slack_get_channel_messages       → projectSlug
slack_get_thread                 → projectSlug, threadTs
```

— matched exactly against each tool's current schema in
`packages/agent/src/tools.ts`, not invented. `propose_linear_issue` has no
entry at all: its span gets no extra attributes, deliberately, since every
one of its input fields (`title`, `description`, `rationale`) is content,
not an identifier. Content fields (`title`, `description`, `rationale`,
`text`, `body`) are never whitelisted for any tool, and
`packages/agent/src/trace-attributes.test.ts` asserts this directly by
iterating every current tool schema and confirming none of its content
fields ever appear in the emitted attributes — not just for the tools that
happen to have one today.

This is observability-only: `toolCallAttributes()` only reads `call.input`
to decide what to attach to the span; it never affects what
`executeTool()` receives or does.

## Python dependencies

No pytest, no pydantic — consistent with this project's standing
preference for hand-rolled minimalism over a dependency for something
small and stable (see `docs/decisions.md`'s hand-rolled tool loop and
hand-rolled canonical-JSON digest entries).

- **No pytest.** The actual need is data-driven scenarios × N trials →
  aggregated pass-rates → a two-part report (Quality table + Safety
  section) — a straight pipeline, not independent test-function discovery.
  `evals/run.py` (~90 lines) does this directly. A thin
  `test_evals.py` wrapping `run.py` for CI is a reasonable _later_
  addition, not core infrastructure.
- **No pydantic.** The scenario schema is small and stable (4 kinds,
  mostly-optional fields); `Scenario` (`evals/scenario.py`) is a plain
  `@dataclass` with a ~15-line loader that rejects unknown fields and
  validates required-field-per-kind. Revisit if the schema grows enough
  distinct per-kind shapes that ad hoc validation gets genuinely
  error-prone.
- **One real dependency: `anthropic`** (`evals/requirements.txt`) — for
  judge calls, keeping first-party-SDK consistency with the TS side's
  `@anthropic-ai/sdk`.
- Scenario/fixture format is **JSON**, not YAML — stays in the standard
  library (`json`), matches the trace files already being JSON/JSONL.
- `.env` is loaded with a ~20-line hand-rolled parser (`evals/env.py`)
  rather than adding `python-dotenv` for one file read.
- Sequential trial execution by default — trials are I/O-bound
  (subprocess + network), so `concurrent.futures.ThreadPoolExecutor` would
  suffice if parallelism is ever needed; deferred until suite runtime is
  actually a bottleneck.

## Running it

```bash
cd evals && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python run.py --suite smoke   # from repo root: evals/.venv/bin/python evals/run.py --suite smoke
.venv/bin/python run.py --suite full
.venv/bin/python run.py --live
```

Each run prints a human-readable report to stdout and writes a
machine-readable JSON report to `evals/results/<suite>-<timestamp>.json`
(gitignored). Every failing trial in the human-readable report is
annotated with its trace ID and run ID for investigation; `evals/runs/`
(gitignored) holds every trial's config and trace artifact.
