# Architecture

Status: Phase 0 + Phase 1 (first vertical slice). No UI, no writes, no observability
infrastructure, no MCP yet — see `docs/decisions.md` for why each of those is deferred.

## Data flow

```text
CLI (apps/cli)
  reads ANTHROPIC_API_KEY, LINEAR_API_KEY, GITHUB_TOKEN, LINEAR_PROJECT_ID_ACME
  builds AgentDependencies
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
    - IssueTracker.listProjectIssues(linearProjectId)
    - PullRequestSource.listPullRequests(owner, repo)
    - PullRequestSource.getWorkflowRunStatus(owner, repo, ref)  — GitHub Actions API, not Checks API (see docs/decisions.md)
  converts each result into Evidence[] (source, id, url, summary, timestamp)
      │
      ▼
LinearIssueTracker (@agency-os/integration-linear)   GitHubPullRequestSource (@agency-os/integration-github)
  wraps @linear/sdk                                    wraps @octokit/rest
      │                                                       │
      ▼                                                       ▼
Linear GraphQL API                                     GitHub REST API
```

## Package boundaries

```text
packages/shared            — Evidence, ProjectRegistryEntry, InvestigationResult types
packages/integrations/linear   — IssueTracker interface + LinearIssueTracker
packages/integrations/github   — PullRequestSource interface + GitHubPullRequestSource
packages/agent              — tool schemas, tool dispatch, system prompt, the loop
apps/cli                    — env wiring + stdout/stderr presentation
```

Business logic (`packages/agent`) depends on the `IssueTracker` / `PullRequestSource`
interfaces, not on `@linear/sdk` or `@octokit/rest` response shapes directly
(AGENTS.md #11). Each interface has exactly one implementation today — no
generic "SaaS provider" abstraction has been introduced, since only one
provider exists per capability (AGENTS.md #42).

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
place to add human-approval gating once write tools exist (Phase 3).

Every tool call is wrapped in try/catch: a failure becomes an `is_error`
tool_result so Claude sees it and can say "I couldn't retrieve X" instead of
guessing, and is also recorded in a `ToolCallRecord` trace (tool name, input,
ok/error, duration). The `onEvent` hook and `ToolCallRecord[]` exist so a
later observability layer (Phase 4) can be wired in without changing the
loop's control flow.

## Read/write boundary

Everything implemented so far is read-only (`IssueTracker.listProjectIssues`,
`PullRequestSource.listPullRequests`, `PullRequestSource.getWorkflowRunStatus`).
There is no approval-gating code yet because there is nothing to gate —
AGENTS.md #14/#15's approval architecture becomes real infrastructure (not
just a prompt instruction) starting in Phase 3, at which point the hand-rolled
loop chosen here is where that gate gets inserted.

## MCP

Not used yet. Both integrations are called as plain TypeScript classes.
README §8 requires at least one custom MCP server somewhere in the project;
the plan is a Phase 1.5 MCP server wrapping `LinearIssueTracker` once the
read-only flow here is proven — see `docs/decisions.md`.
