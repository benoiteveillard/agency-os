# Phase 7.2 verification — 2026-09-15

## Result

Implemented Hono/Node web transport around the unchanged agent. No UI or deployment.
Production wiring is shared with CLI through `@agency-os/runtime`.

- Typecheck, lint, format and diff whitespace checks: pass.
- Deterministic tests: **188/188**, 27 files (53 added: 3 factory, 9 store,
  24 HTTP, 1 actual Node socket, 7 progress, 9 presentation).
- Eval smoke: **9/9**, three agentic trials plus six deterministic scenarios;
  no safety incident reported. Full 50-trial suite not rerun.
- Both production bundles build. Live server used `node apps/web/dist/server.js`
  and explicit compiled `LINEAR_MCP_SERVER_ENTRY`.
- Hono packages were already present transitively through MCP; they are now
  direct web dependencies. The final Node adapter is pinned to the repository’s
  existing 2.1.1 to avoid a transitive downgrade. The recorded SaaS run used
  1.19.17; an actual streaming TCP regression test and full checks passed with
  final 2.1.1, without repeating the paid agentic run.
- Direct runtime dependencies: `hono@4.13.7`, `@hono/node-server@2.1.1`.
  Web build reuses `esbuild@0.28.2` already used by MCP; dotenv already existed.
- North-star question: “Are we still on track to launch Project Acme on Friday?”
- Actual streaming HTTP response: 200, text/event-stream, Cache-Control no-store.
  A Python urllib streaming reader timestamped each frame as it arrived.
- First event at 0.044 s; final result at 91.517 s. This is one measured run.

## Live result and tracing

Investigation trace: `62bf9de1ccb25e0f5dae194cedf55ed4`.
Assessment `high_risk`, five blockers, 37 evidence references from Linear/GitHub/
Slack; every assessment source reference resolves. 13 tool calls, 110,636 input
and 9,260 output tokens, 91,424 ms runtime duration.

The reported blockers include missing formal client approval (JUS-6), incomplete
CMS migration with failing CI on PR #12 (JUS-7), unfinished mobile validation
(JUS-9), analytics validation (JUS-5), and deployment rehearsal blocked by
credentials (JUS-18/JUS-19). Verdict is consistent with the returned evidence
references and existing risk definition. Injection content was recognized and
disregarded in the answer.

Proposal `0724a70e-121f-4791-a27d-2e60b840a017` was generated and rejected through
`POST /api/proposals/:id/decide`. HTTP response: decision rejected, no execution
field. No real write was approved or performed.
Approval trace: `39ba2e9ce7b937cf3de55254b3f1fece`, correlated to the investigation
through root attributes. Both OTLP exports reported `attempted:true,ok:true`.
This confirms exporter acceptance, not a separate manual Grafana UI inspection.

## Exact observed SSE sequence

Times are seconds since the streaming HTTP request began. Repeated activities
are real distinct spans; `ok:false` assessment completions are validation
failures, not failed source retrievals.

| Seconds | Event                     | Source | ok    |
| ------- | ------------------------- | ------ | ----- |
| 0.044   | `investigation.started`   |        |       |
| 0.149   | `assessment.started`      |        |       |
| 2.916   | `assessment.completed`    |        | true  |
| 2.916   | `source.started`          | linear |       |
| 5.055   | `source.completed`        | linear | true  |
| 5.057   | `source.started`          | github |       |
| 6.023   | `source.completed`        | github | true  |
| 6.023   | `source.started`          | slack  |       |
| 6.228   | `source.completed`        | slack  | true  |
| 6.228   | `assessment.started`      |        |       |
| 13.301  | `assessment.completed`    |        | true  |
| 13.302  | `source.started`          | slack  |       |
| 13.505  | `source.completed`        | slack  | true  |
| 13.505  | `source.started`          | slack  |       |
| 13.658  | `source.completed`        | slack  | true  |
| 13.658  | `source.started`          | slack  |       |
| 13.861  | `source.completed`        | slack  | true  |
| 13.861  | `source.started`          | github |       |
| 14.320  | `source.completed`        | github | true  |
| 14.320  | `source.started`          | github |       |
| 14.677  | `source.completed`        | github | true  |
| 14.677  | `assessment.started`      |        |       |
| 37.102  | `assessment.completed`    |        | true  |
| 37.102  | `assessment.started`      |        |       |
| 37.102  | `assessment.completed`    |        | false |
| 37.102  | `assessment.started`      |        |       |
| 52.710  | `assessment.completed`    |        | true  |
| 52.711  | `assessment.started`      |        |       |
| 52.711  | `assessment.completed`    |        | false |
| 52.711  | `assessment.started`      |        |       |
| 66.262  | `assessment.completed`    |        | true  |
| 66.263  | `assessment.started`      |        |       |
| 66.263  | `assessment.completed`    |        | false |
| 66.263  | `assessment.started`      |        |       |
| 80.059  | `assessment.completed`    |        | true  |
| 80.060  | `assessment.started`      |        |       |
| 80.060  | `assessment.completed`    |        | true  |
| 80.060  | `assessment.started`      |        |       |
| 91.465  | `assessment.completed`    |        | true  |
| 91.517  | `assessment.ready`        |        |       |
| 91.517  | `action.proposed`         |        |       |
| 91.517  | `investigation.completed` |        |       |

## Privacy checks and limits

Live payload checks: configured secret values absent; no internal trace field;
no evidence summaries; no proposal args/digest; full known injection fixture
string absent. Unit/HTTP tests also insert representative secrets, auth headers,
Slack bodies, injected instructions and raw tool data into omitted internal
fields and verify their exclusion.

The actual narrative and proposal contain short quotations from Slack, as part
of the requested customer-facing answer. This phase does **not** claim that all
model-generated prose is free of source quotations. It omits raw evidence bodies
and tool/trace payloads at the DTO boundary. Suppressing all quotations while
preserving the original narrative/assessment would require a separate content
policy; no agent behavior was changed to achieve an overstated privacy claim.

## Reliability finding

The known Phase 7.1 structured-tool correction issue appeared again: three
`submit_assessment` validation failures before one valid submission. The run
ultimately completed with a correct assessment. No retry policy, prompt,
assessment tool or agent loop change was made. Latency and token usage above
include this retry cost. Earlier 44/50 full-suite results are not superseded by
this 9/9 smoke result.

## Operational behavior

Pending proposals last 15 minutes; expired tombstones and decided results last
15 further minutes. `pending → deciding` is synchronous before awaiting the
existing approval function. Same-decision concurrent requests receive 409;
completed retries replay without writing; conflicting decisions receive 409.
Failure and executed_unconfirmed are terminal. Store capacity is 1,000 entries.
State is in memory in one process and is lost on restart.

Client disconnect stops transport polling but lets the current investigation
finish, close MCP, retain a proposal and persist/export traces. Tests cover
this behavior and independent simultaneous investigations. Approval uses a
separate correlated trace, not a fictional cross-request parent.

See [web-runtime.md](web-runtime.md) for the exact request/response DTOs,
error statuses, lifecycle, event vocabulary and local commands.
