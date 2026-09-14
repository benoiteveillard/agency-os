# Architectural decisions

## GitHub Checks API is unusable with a fine-grained PAT — CI signal moves to Actions

**Context.** The live Phase 1 smoke test's `github_get_check_status` tool
(`GET /repos/{owner}/{repo}/commits/{ref}/check-runs`) failed with `403
Resource not accessible by personal access token` against the real
`os-agency-fake/acme-website-migration` repo. The response's
`X-Accepted-GitHub-Permissions: checks=read` header suggested a missing
permission, so before touching the token we verified what's actually
grantable.

**Verified facts (not assumed):**

- GitHub support has confirmed fine-grained PATs cannot currently be
  granted `checks=read` at all — the Checks API is GitHub-App-only right
  now, regardless of what's selected in the token UI (GitHub community
  discussion [#129512](https://github.com/orgs/community/discussions/129512),
  Mar 2025: "it isn't possible to assign Checks permissions to a
  Fine-grained PAT — only GitHub Apps can access this API"). No PAT
  permission change fixes this.
- By contrast, both `actions=read` ("Actions") and `statuses=read` ("Commit
  statuses") are real, currently-grantable fine-grained PAT repository
  permissions (confirmed against
  [GitHub's fine-grained PAT permissions reference](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens)),
  and both endpoints 403'd with those exact permission names when tried
  live — i.e. they're real alternatives, just not yet granted.
- The demo repo has exactly one workflow, `.github/workflows/ci.yml`,
  triggered `on: pull_request` (and `push` to `main`) — confirmed by
  reading its contents via the Contents API (already permitted). No
  evidence of any process writing classic commit statuses instead.
- `pulls.get().mergeable_state` works today under the already-granted
  Pull-requests permission with zero changes, but GitHub documents it as a
  coarse mergeability signal ("unstable" = pending/non-required checks),
  not a per-check pass/fail breakdown — too ambiguous for a tool named
  `get_check_status`, so it was ruled out as a CI-status substitute.

**Decision.** GitHub Actions is the real, configured CI source for this
repo (workflow trigger config confirms it; no counter-evidence for Commit
Status). Once `Actions: Read-only` is added to the fine-grained PAT,
`github_get_check_status` will be replaced by an Actions-based tool
(`GET /repos/{owner}/{repo}/actions/runs?head_sha=...`) rather than kept
pointed at the Checks API.

**Not yet done:** the permission hasn't been granted yet, so actual
workflow-run data for the two open PRs' head commits (does a run exist, did
it pass) is still unconfirmed — the trigger-config check proves the
workflow _would_ fire on PR events, not that a run necessarily exists for
every current head SHA. Confirm this once `Actions: Read-only` is granted,
before finalizing the replacement tool's behavior.

**Why not Commit Status API instead?** Nothing in the repo writes classic
commit statuses (`ci.yml` is a GitHub Actions workflow, which reports via
check runs by default, not the legacy Status API) — granting
`Commit statuses: Read-only` would be permission scope with no matching
data behind it.

**Revisit when** `Actions: Read-only` is granted and workflow-run data is
confirmed to exist for real PR commits — at that point implement the
replacement tool and update `packages/agent/src/tools.ts`.

**Resolved (2026-09-14).** `Actions: Read-only` was granted. Live
verification against the real repo found exactly one workflow run per open
PR's head SHA — `CI` run #7 (`success`) for PR #11, `CI` run #8 (`failure`)
for PR #12 — confirming both that runs exist and that the failing-CI
scenario from README §2 is real. Implemented: `PullRequestSource.getCheckStatus`
→ `getWorkflowRunStatus` (`packages/integrations/github/src/workflow-run-status.ts`,
backed by `actions.listWorkflowRunsForRepo`), and the agent tool renamed
`github_get_check_status` → `github_get_workflow_run_status`
(`packages/agent/src/tools.ts`). An empty run list still maps to
`status: "unknown"`, not a guessed pass/fail.

---

## Monorepo: pnpm workspaces, no build step yet

**Context.** Phase 0 needs a TypeScript monorepo with shared packages, but the
only consumer right now is a CLI run via `tsx` in development.

**Decision.** pnpm workspaces (`packages/*`, `packages/integrations/*`,
`apps/*`). Every package's `package.json` points `exports`/`types` straight
at `./src/index.ts` — no `dist/`, no build step. `tsconfig.base.json` uses
`moduleResolution: "Bundler"`, which lets `tsc --noEmit` and `tsx` resolve
the same extensionless-or-`.js` relative imports without the NodeNext
`.js`-suffix requirement.

**Why.** Nothing here is deployed or published yet; a build pipeline would be
pure overhead (AGENTS.md #43).

**Revisit when** something needs a compiled artifact — e.g. deploying `apps/api`
as a Cloudflare Worker, or publishing a package for external consumption.

---

## TypeScript pinned to `~6.0.3`, not the installed-by-default 7.x

**Context.** `npm view typescript version` currently resolves to `7.0.2` (the
new Go-based compiler). `typescript-eslint@8.70.0`'s peer dependency range is
`>=4.8.4 <6.1.0` — it does not yet support TypeScript 7, or even TypeScript
6.1+.

**Decision.** Pin `typescript` to `~6.0.3`, the newest version still inside
typescript-eslint's supported range.

**Why.** AGENTS.md #7 forbids assuming tool/library compatibility from
memory; this was caught by checking `npm view typescript-eslint peerDependencies`
before installing, not by trial and error.

**Revisit when** typescript-eslint ships a release supporting TS 6.1+/7.x.

---

## No MCP in Phase 1; a custom Linear MCP server is planned for Phase 1.5

**Context.** Both Linear and GitHub ship official hosted remote MCP servers.
Anthropic's native MCP connector only reaches public-HTTPS remote servers, not
locally-run stdio ones, so it isn't usable for a locally-run custom server
without extra hosting. Standing up any MCP server or client today adds
transport/wiring complexity with no functional benefit for a two-tool
read-only slice.

**Decision.** Phase 1 calls `LinearIssueTracker` and `GitHubPullRequestSource`
directly as TypeScript classes behind the `IssueTracker`/`PullRequestSource`
interfaces. Once this flow is proven, wrap `LinearIssueTracker` in a small
custom MCP server (Phase 1.5) exposing `linear.list_project_issues` /
`linear.get_issue` — satisfying README §8's "at least one custom MCP server"
requirement — without having built it before there was a second real
consumer to justify it (AGENTS.md #42).

**Why not GitHub instead?** Either integration would satisfy the requirement;
Linear was chosen because its relation-heavy read model (`issue.relations()` /
`inverseRelations()`) is a more interesting demonstration of MCP tool design
than GitHub's flatter PR/check-run data.

**Revisit when** the Phase 1.5 milestone starts, or if a second consumer of
either integration appears sooner (e.g. Claude Desktop).

**Resolved (2026-09-14).** Phase 1.5 implemented the Linear MCP server and,
per an explicit decision to make it the _real_ execution path rather than a
demo-only add-on, went further than originally planned here: `apps/cli` now
reaches Linear exclusively through it. See the next entry for why.

---

## Linear moved behind the custom MCP server; GitHub stays direct

**Context.** Phase 1.5 built `mcp/linear`, a custom MCP server wrapping
Linear reads (previous entry). The question was whether to make it a
demo-only artifact alongside the still-direct `LinearIssueTracker` calls, or
the actual execution path the running agent uses.

**Decision.** Linear now goes through MCP for real:

```text
Agent → IssueTracker (interface, unchanged)
      → McpLinearIssueTracker (packages/integrations/linear-mcp-client)
      → MCP Client.callTool() over stdio
      → mcp/linear/src/server.ts (child process)
      → IssueTracker → LinearIssueTracker → Linear API
```

GitHub deliberately stays exactly as it was: `GitHubPullRequestSource`
called in-process from `packages/agent`, no MCP involved.

**Why this asymmetry, and why now.** The reason is deliberate incremental
adoption of a new architectural boundary, not an oversight or
inconsistency: proving MCP as a real production path is worth doing on
_one_ capability first — where a regression is contained and cheap to
diagnose — before deciding whether to standardize it across every
integration. GitHub was left alone specifically so there would be a
same-session, same-questions comparison point: if something broke or
degraded, "did the MCP move cause it?" has an immediate answer, because
GitHub's behavior is the control. Converting both integrations at once
would have made that comparison impossible and doubled the blast radius of
a boundary that had not yet been validated with real traffic.

**What stayed true to the interface boundary already in place.** This
migration only worked as cleanly as it did because `packages/agent` already
depended on `IssueTracker` (AGENTS.md #11) rather than on
`LinearIssueTracker` — the interface designed in Phase 1 for "business logic
shouldn't depend on provider SDKs" turned out to be exactly the seam needed
for "business logic shouldn't depend on transport, either." `runner.ts` and
`tools.ts` required zero changes; the only agent-side change was in
`apps/cli`'s dependency construction (which `IssueTracker` implementation to
build).

**Cost discovered in practice.** The MCP boundary is not free. A cold spawn
of the server (first run after code changes, before tsx's transform cache is
warm) took ~28s for a single `linear_list_project_issues` call that
completes in under a second in-process; a warm-cache spawn dropped to
~300ms handshake + ~1s for the same call — roughly in line with Phase 1's
direct-call latency, but only once warm. This is a real, measured
production cost of choosing stdio + on-the-fly TypeScript transpilation for
local dev, not a one-time fluke — see `docs/decisions.md`'s "Monorepo" entry
for the no-build-step choice this depends on, and revisit it if the MCP
server ever needs cold-start latency guarantees.

**Revisit when** either (a) evaluation data (Phase 5) shows the MCP boundary
measurably helps or hurts answer quality/reliability, giving a real basis to
decide whether GitHub should move too, or (b) the cold-start cost above
becomes a real problem — at which point precompiling `mcp/linear` to plain
JS (removing the tsx transpilation step from the spawn path) is the fix, not
abandoning MCP.

---

## Hand-rolled Anthropic tool-use loop, not the beta `toolRunner()` helper

**Context.** `@anthropic-ai/sdk` ships a beta `client.beta.messages.toolRunner()`
that runs the tool_use/tool_result loop automatically.

**Decision.** `packages/agent/src/runner.ts` implements the loop explicitly:
call, inspect `tool_use` blocks, dispatch each through `executeTool()`,
catch and surface errors as `is_error` tool_results, repeat up to 8 turns.

**Why.** Explicit control over tool dispatch, error handling, and an
`onEvent` hook is needed now so that Phase 3's approval gate and Phase 4's
observability can be inserted into a loop that's already legible, rather than
retrofitted into a black-box helper. `toolRunner()` remains a reasonable
choice for a purely-read-only, no-tracing throwaway script; it wasn't right
here given where this loop is headed.

**Revisit when** `toolRunner()` (or its successor) supports the
approval-interception and event-hook needs directly — unlikely to be worth
switching back even then, since the current loop is ~90 lines.

---

## Linear auth: scoped read-only personal API key (not OAuth)

**Decision.** `LINEAR_API_KEY` is a personal API key scoped to Read, passed
to `new LinearClient({ apiKey })`.

**Why.** OAuth2 is for multi-tenant apps acting on behalf of different
Linear users; this is a single-tenant demo hitting one dedicated sandbox
workspace. A scoped key is simpler to provision and revoke, and read-only
scoping means a leaked key can't mutate the sandbox.

**Revisit when** the project needs to act on behalf of multiple Linear
workspaces, or once write operations (Phase 3) need write scope — at that
point, use a separate, explicitly-write-scoped key rather than broadening
this one.

---

## GitHub auth: fine-grained PAT (not a GitHub App)

**Decision.** `GITHUB_TOKEN` is a fine-grained personal access token scoped
to `os-agency-fake/acme-website-migration` with read-only Pull requests and
Checks permissions.

**Why.** A GitHub App is the correct production pattern (short-lived
installation tokens, higher rate limits, better audit trail) but needs app
registration, a private key, and an installation flow — disproportionate
setup for a single-repo read-only demo. A fine-grained PAT gets the same
least-privilege scoping with far less setup.

**Revisit when** the project needs to act across multiple repos/orgs, or
before any production-facing deployment — document the GitHub App migration
at that point rather than broadening PAT scope.

---

## Static, typed project registry (not dynamic discovery)

**Decision.** `packages/shared/src/project-registry.ts` exports
`loadProjectRegistry()`, a hardcoded `Record<string, ProjectRegistryEntry>`
keyed by slug. `linearProjectId` is read from `LINEAR_PROJECT_ID_ACME` at
call time (not hardcoded), since it isn't knowable until the synthetic Linear
project actually exists; `githubOwner`/`githubRepo` are hardcoded since they
were provided directly (`os-agency-fake`/`acme-website-migration`).

**Why.** Linear and GitHub have no inherent link; matching them by name
heuristics would be fragile and non-deterministic. A second project should
be onboarded by adding one entry to this object, not by building a registry
service.

**Revisit when** there are enough projects that hand-editing this file
becomes the bottleneck — not before.

---

## No seed scripts

**Decision.** No script was written to populate Linear/GitHub with synthetic
data.

**Why.** The demo environments are already being populated separately by the
project owner. Writing seed logic now would duplicate that effort with no
current reproducibility need (AGENTS.md #43's spirit: don't build
infrastructure ahead of a concrete requirement).

**Revisit when** reproducible fixtures are needed for the evaluation suite
(Phase 5) — at that point a seed script also becomes useful as an eval-data
generator, which is a concrete enough reason to write one.
