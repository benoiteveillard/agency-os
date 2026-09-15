# Phase 7.2 — Web runtime and transport

`apps/web` is a Hono / `@hono/node-server` adapter around the unchanged
`investigate()` and `reviewAndExecute()`. CLI and Web share
`@agency-os/runtime`, the concrete production integration factory. The writer
is separate from `AgentDependencies`; it never enters the model's tool loop.
No frontend, authentication, persistence service or deployment configuration
is included in this phase.

## Local execution

Run `pnpm web` from the repository root for development. It loads the root
`.env`, like the CLI. The default bind address is `127.0.0.1:3000`; server-owned
`HOST` and `PORT` can override it. This unauthenticated adapter is intended for
local verification; public access is not an authentication boundary.

`pnpm build` builds both the existing Linear MCP bundle and the web bundle.
To exercise the compiled paths locally from the repository root:

```sh
LINEAR_MCP_SERVER_ENTRY="$PWD/mcp/linear/dist/server.js" pnpm --filter @agency-os/web start
```

Both run with Node, without runtime TypeScript compilation. The explicit MCP
environment variable remains the Phase 7.0 integration contract. Development
uses its existing tsx fallback. The web bundle includes workspace packages;
it does not depend on their source `.ts` exports at runtime.

## HTTP contract

- `GET /health` → `200 {"status":"ok"}`. Process liveness, not a credential or
  provider connectivity probe.
- `POST /api/investigate` accepts exactly `{"question": string}`. Trimmed,
  nonempty, at most 8,000 original UTF-16 code units. No client agent options.
- `POST /api/proposals/:proposalId/decide` accepts exactly
  `{"decision":"approve"}` or `{"decision":"reject"}`.

Both POST routes require `application/json` (optional charset accepted), reject
unknown fields, and limit the entire body to 32 KiB. Validation failures are
`400 invalid_request`; oversized bodies are `413 invalid_request`. Browser
cross-origin requests are rejected with `403 invalid_request`; there is no CORS
allowlist. Responses carry `Cache-Control: no-store`. No raw exception messages,
provider responses, stack traces or credentials are returned.

## Streaming event contract

Use a streaming POST client (`fetch` + response reader, or `curl -N`), not the
GET-only native `EventSource` API. Each frame is `event`, one JSON `data` line,
monotonically increasing per-response `id`, then a blank line. IDs express
order only: no reconnection, replay or Last-Event-ID support.

| Event                     | Data                                                    | Meaning                                                         |
| ------------------------- | ------------------------------------------------------- | --------------------------------------------------------------- |
| `investigation.started`   | `{traceId}`                                             | This run has started.                                           |
| `source.started`          | `{activityId,source}`                                   | An actual source tool span appeared.                            |
| `source.completed`        | `{activityId,source,ok}`                                | That span ended, successfully or with error.                    |
| `assessment.started`      | `{activityId}`                                          | An actual model turn or structured assessment submission began. |
| `assessment.completed`    | `{activityId,ok}`                                       | The corresponding span ended.                                   |
| `assessment.ready`        | `{verdict,blockerCount}`                                | Valid structured assessment available in final result.          |
| `action.proposed`         | Proposal presentation below                             | Canonical proposal is now stored.                               |
| `investigation.completed` | Result presentation below                               | Terminal success.                                               |
| `investigation.failed`    | `{error:{code:"investigation_failed",message},traceId}` | Terminal investigation failure.                                 |

Sources are exactly `linear`, `github`, `slack`. The mapper polls live
`Tracer.getSpans()` every 50 ms. It recognizes exact names/categories, inspects
only lifecycle fields, and deduplicates transitions by span ID. Activity IDs
are small integers for pairing transitions, not raw span records. A span that
starts and ends between polls still emits both transitions. Observed transitions
are timestamp-sorted within a poll; timing has 50 ms granularity and is not a
claim of exact tool-call arrival time. Nothing fabricates completed work.
Model turns are assessment activity, never an exposure of internal reasoning.
Unknown spans are ignored. `assessment.ready` and `action.proposed` are optional
and occur after the agent returns, before terminal completion.

### Final result

```ts
{
  answer: string;
  assessment?: Assessment; // existing contract, explicitly projected
  evidence: Array<{
    evidenceId: string; // `${source}:${id}`, unchanged reference scheme
    source: "linear" | "github" | "slack";
    id: string;
    timestamp?: string;
    url?: string;
  }>;
  proposedActionPresentation?: {
    proposalId: string;
    kind: "linear_create_issue";
    title: string;
    description: string;
    priority: number;
    teamId: string;
    projectId: string;
    rationale: string;
    expiresAt: string;
  };
  metadata: {
    traceId: string;
    durationMs: number;
    toolCallCount: number;
    inputTokens?: number;
    outputTokens?: number;
  };
}
```

The proposal shows the exact content and target for review, but neither its
digest nor its provider creation UUID. The decision request cannot submit or
change any of these presentation fields. Evidence omits `summary` because Slack
summaries contain verbatim message bodies. URLs come only from existing evidence,
require provider-owned HTTPS hosts, and omit query strings, fragments and
credential-bearing links. No Slack URL is invented. Every assessment reference
is checked again against the projected evidence IDs. Broken references fail closed.
Token counters sum nonnegative finite integer values on actual `model.turn`
spans only. These are the existing input/output counters; cache counters are not
silently included. Duration covers construction and investigation, excluding
MCP teardown and trace export.

### Decisions and errors

The successful response is an explicit audit projection:
`{proposalId,decision,decidedAt,execution?}`. `execution` contains `outcome`,
optional `createdIssue:{identifier,title,url}`, or a generic `execution_failed`
error. It never contains action arguments, digest, or provider error bodies.

| Condition                                      | HTTP response                                      |
| ---------------------------------------------- | -------------------------------------------------- |
| Unknown / forgotten ID                         | `404 proposal_not_found`                           |
| Expired, retained tombstone                    | `410 proposal_expired`                             |
| Same decision currently executing              | `409 proposal_in_progress`                         |
| Conflicting decision                           | `409 proposal_already_decided`                     |
| Rejected                                       | `200`, decision rejected, no execution             |
| Approved and read-back confirmed               | `200`, execution outcome success                   |
| Write succeeded, read-back failed              | `200`, outcome executed_unconfirmed                |
| Execution failed / unexpected callback failure | `502`, generic execution_failed                    |
| Same completed decision repeated               | Replay its audit response, without executing again |

`executed_unconfirmed` is terminal; never retry a write on this outcome. A write
failure may itself be ambiguous, so even failures cannot be re-executed under
that proposal. Unexpected errors before HTTP streaming use a generic
`500 internal_error`; Hono's streaming fallback error message is sanitized too.

## Proposal lifecycle and concurrency

```text
pending → deciding → decided (rejected / success / failure / executed_unconfirmed)
                  ↘ failed (unexpected exception; terminal)
pending → expired → forgotten
```

Canonical proposals are deep-cloned and frozen at insertion. `deciding` is set
synchronously before invoking/awaiting the callback. Two requests therefore
cannot enter `reviewAndExecute` for the same proposal. Existing digest
recomputation remains the final approval boundary. The store never rebuilds
canonical arguments from the browser.

Pending TTL is 15 minutes. Decided/failed results and expired tombstones remain
for 15 minutes, then become unknown. Lazy cleanup runs on insert/decide, with a
1,000-entry cap; at capacity insertion fails closed instead of evicting a retry
guard. Active decisions cannot expire or be evicted. No IDs can be submitted for
insertion over HTTP. An old ID after eviction or process restart is unknown and
cannot trigger execution. This guarantee is per proposal, within one process;
new investigations may propose semantically similar actions.

Each investigation has its own runtime/MCP child, tracer, mapper, and agent-local
state. Approval constructs a fresh runtime; the first investigation's MCP child
has already closed. This also means rejection currently requires valid runtime
configuration and a successful MCP connection, even though it performs zero
writes. This modest coupling keeps one production wiring path and is a future
availability improvement, not an approval bypass.

Railway V1 assumes one persistent Node process. Multiple replicas would need a
shared proposal store and coordination; neither is implemented. Restart loses
all pending proposals and audit replays. There is no history or resume API.

## Disconnect and observability

Choice B: the investigation finishes after client disconnect. The unchanged agent
API has no cancellation signal. Polling and client writes stop after disconnect;
the running investigation still closes its runtime, retains any canonical
proposal until TTL, and persists/exports its trace. This is in-flight work in
one process, not a background-job system. There is no result recovery endpoint.
The existing agent turn limit and provider timeouts remain unchanged.

Investigation owns one `agent.run` root. Existing model/tool/assessment/proposal
spans remain its descendants. Approval has a separate `web.approval` root with
`proposalId` and `investigationTraceId` attributes; no fabricated parent across
requests. Retried decisions do not create another execution trace.

Local `.traces/<traceId>.jsonl` keeps existing scalar spans; web run summaries
omit question/answer text. The existing OTLP exporter is optional, disabled by
default, best effort, and asynchronous relative to the HTTP response. Its result
is logged as `{event:"trace.export",traceId,attempted,ok}`, without endpoint,
credentials or provider response text. Export failure cannot fail the response.

The HTTP boundary is an allowlisted projection, not a general content sanitizer:
answer, assessment prose and proposal text are intentionally customer-facing
model output. A model can quote retrieved text in those fields; privacy tests
prove raw evidence/trace/tool fields are excluded, not that arbitrary generated
prose can never repeat external content. Future UI must render these fields as
untrusted text/sanitized Markdown, never raw HTML. Prompt-injection behavior,
known structured-tool retry failures and token overhead are unchanged.

Implementation references: [Hono SSE helper](https://hono.dev/docs/helpers/streaming)
and [Hono Node adapter](https://hono.dev/docs/getting-started/nodejs).
