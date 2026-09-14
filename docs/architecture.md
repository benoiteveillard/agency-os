# Architecture

Status: Phase 0 + Phase 1 + Phase 1.5. No UI, no writes, no observability
infrastructure yet — see `docs/decisions.md` for why each of those is deferred.

## Data flow

```text
CLI (apps/cli)
  reads ANTHROPIC_API_KEY, LINEAR_API_KEY, GITHUB_TOKEN, LINEAR_PROJECT_ID_ACME
  spawns the Linear MCP server (stdio child process), builds AgentDependencies
      │
      ▼
investigate() (packages/agent/src/runner.ts)
  hand-rolled Anthropic tool-use loop:
    1. send question + system prompt + tool schemas to Claude
    2. if Claude requests tool_use blocks, dispatch each via executeTool()
    3. feed tool_result blocks back, repeat (capped at 8 turns)
    4. once Claude replies with text only, return {answer, evidence, trace}
      │
      ▼
executeTool() (packages/agent/src/tools.ts)
  resolves a projectSlug to a ProjectRegistryEntry, then calls one of:
    - IssueTracker.listProjectIssues(linearProjectId)      — Linear, via MCP
    - IssueTracker.getIssue(idOrIdentifier)                — Linear, via MCP (not yet an agent tool)
    - PullRequestSource.listPullRequests(owner, repo)      — GitHub, in-process
    - PullRequestSource.getWorkflowRunStatus(owner, repo, ref) — GitHub Actions API, in-process
  converts each result into Evidence[] (source, id, url, summary, timestamp)
      │
      ├── Linear path ──────────────────────────────────────────────┐
      │                                                              │
      ▼                                                              ▼
McpLinearIssueTracker                                    GitHubPullRequestSource
(@agency-os/integration-linear-mcp-client)               (@agency-os/integration-github)
  implements IssueTracker via MCP Client.callTool()         wraps @octokit/rest directly
      │ (stdio, JSON-RPC)                                          │
      ▼                                                             ▼
mcp/linear/src/server.ts (child process)                  GitHub REST API
  McpServer + registerLinearTools()
  handlers depend on IssueTracker, injected with
  a real LinearIssueTracker
      │
      ▼
LinearIssueTracker (@agency-os/integration-linear)
  wraps @linear/sdk
      │
      ▼
Linear GraphQL API
```

The agent never knows Linear is reached through MCP — `packages/agent`
depends only on the `IssueTracker` interface, exactly as it did in Phase 1.
GitHub remains in-process; see `docs/decisions.md` for why this asymmetry is
deliberate.

## Package boundaries

```text
packages/shared                     — Evidence, ProjectRegistryEntry, InvestigationResult types
packages/integrations/linear        — IssueTracker interface, LinearIssueTracker, resolveProjectIssue
packages/integrations/linear-mcp-client — McpLinearIssueTracker (implements IssueTracker via MCP)
packages/integrations/github        — PullRequestSource interface + GitHubPullRequestSource
packages/agent                      — tool schemas, tool dispatch, system prompt, the loop
mcp/linear                          — custom Linear MCP server (McpServer + tool handlers)
apps/cli                            — env wiring, MCP client lifecycle, stdout/stderr presentation
```

Business logic (`packages/agent`) depends on the `IssueTracker` /
`PullRequestSource` interfaces, never on `@linear/sdk`, `@octokit/rest`, or
`@modelcontextprotocol/sdk` response shapes directly (AGENTS.md #11).
`IssueTracker` now has two implementations (`LinearIssueTracker`,
`McpLinearIssueTracker`) — the first case in this repo where an interface
has more than one — but the agent's dependency stays exactly the same
interface import; only `apps/cli`'s dependency-construction code changed.

`mcp/linear`'s tool handlers depend on `IssueTracker`, not on
`LinearIssueTracker` directly — `server.ts` constructs the concrete
implementation and injects it, matching the same interface-not-implementation
rule the agent itself follows.

## Project registry

Linear and GitHub have no inherent link between them. `packages/shared/src/project-registry.ts`
is a small static, typed mapping from an internal slug (e.g.
`acme-website-migration`) to `{ displayName, linearProjectId, githubOwner, githubRepo }`.
The agent's system prompt lists known slugs and display names so Claude can
map a natural-language project reference ("Project Acme") to the correct
slug before calling tools.

`linearProjectId` is read from the `LINEAR_PROJECT_ID_ACME` environment
variable rather than hardcoded, since it isn't knowable until the synthetic
Linear project exists — see `docs/decisions.md`.

## Agent loop

One primary agent, no sub-agents (README §11, AGENTS.md §20). The tool-use
loop in `packages/agent/src/runner.ts` is hand-rolled rather than using the
Anthropic SDK's beta `toolRunner()` helper, so that tool dispatch, error
surfacing, and an event hook (`onEvent`) are explicit and are the natural
place to add human-approval gating once write tools exist (Phase 3). Moving
Linear behind MCP (Phase 1.5) deliberately did not touch this file at all —
the loop only ever talks to `executeTool()`, which only ever talks to
`IssueTracker`/`PullRequestSource` interfaces.

Every tool call is wrapped in try/catch: a failure becomes an `is_error`
tool_result so Claude sees it and can say "I couldn't retrieve X" instead of
guessing, and is also recorded in a `ToolCallRecord` trace (tool name, input,
ok/error, duration). This holds whether the failure originated in-process
(GitHub) or came back as an MCP `isError` result translated into a thrown
`Error` by `McpLinearIssueTracker` (Linear) — the agent can't tell the
difference, by design.

## Read/write boundary

Everything implemented so far is read-only (`IssueTracker.listProjectIssues`,
`IssueTracker.getIssue`, `PullRequestSource.listPullRequests`,
`PullRequestSource.getWorkflowRunStatus`). There is no approval-gating code
yet because there is nothing to gate — AGENTS.md #14/#15's approval
architecture becomes real infrastructure (not just a prompt instruction)
starting in Phase 3, at which point the hand-rolled loop chosen here is
where that gate gets inserted.

## MCP

`mcp/linear` is the project's first custom MCP server (README §8), and as of
Phase 1.5 it is the real execution path for Linear calls in the running
product — not a demo-only add-on. It exposes two business-shaped tools,
`linear_list_project_issues` and `linear_get_issue`, both returning
structured Linear domain data (JSON) rather than a summarized answer; the
agent's `executeTool()` remains solely responsible for turning that domain
data into `Evidence[]`.

Transport is stdio only: `apps/cli` spawns the server as a child process via
`StdioClientTransport` (see `packages/integrations/linear-mcp-client/src/create-client.ts`)
and passes `LINEAR_API_KEY` through an explicit `env` override — the
transport's default spawned environment is a fixed safe allowlist (PATH,
HOME, etc.) that does **not** inherit arbitrary parent env vars, so
injecting the key explicitly is the actual authentication boundary, not an
assumption. No remote hosting, no OAuth, no HTTP/SSE transport yet.

GitHub stays in-process — see `docs/decisions.md` for why moving one
integration behind MCP while leaving the other direct is deliberate
incremental adoption, not inconsistency.
