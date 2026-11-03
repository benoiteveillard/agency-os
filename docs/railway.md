# Railway deployment (Phase 7.4)

Target shape: 1 Railway service, 1 process, 1 replica. See
`docs/decisions.md` "Phase 7.4" for why each of the choices below exists.

## Service structure

```
Internet → Railway → node apps/web/dist/server.js (Hono)
                        ├── serves apps/web/dist/client (static, production React build)
                        ├── /health
                        └── /api/*  → @agency-os/agent
                                        ├── Linear MCP: compiled dist/server.js subprocess (stdio)
                                        ├── GitHub, Slack: direct HTTP
                                        └── Anthropic (Claude)
                      → OTLP exporter (best-effort, non-blocking) → Grafana Cloud Tempo
```

One persistent Node process serves both the API and the static frontend —
not two services, no separate CDN/static host. Proposal state
(`apps/web/src/proposal-store.ts`) is in-memory in that same process.

## Build / start

`railway.json` (repo root) pins this explicitly:

```json
{
  "build": { "builder": "NIXPACKS", "buildCommand": "pnpm build" },
  "deploy": {
    "startCommand": "pnpm start",
    "healthcheckPath": "/health",
    "numReplicas": 1
  }
}
```

Root `package.json` now has `"start": "node apps/web/dist/server.js"` and
`"engines": { "node": ">=22" }`. Nixpacks auto-detects the pnpm workspace
(via the `packageManager` field) and runs its own install step
(effectively `pnpm install --frozen-lockfile`) before `buildCommand`. The
full local-equivalent invariant, verified working from a clean repo root:

```bash
pnpm install --frozen-lockfile   # fixed a real pre-existing lockfile/
                                  # package.json drift — see decisions.md
pnpm build                       # builds mcp/linear/dist/server.js (esbuild)
                                  # AND apps/web/dist/{server.js,client/} (esbuild + vite)
pnpm start                       # node apps/web/dist/server.js, from repo root
```

Production startup never invokes `tsx` for the Linear MCP server — it
spawns the precompiled `mcp/linear/dist/server.js` directly, via the
existing `LINEAR_MCP_SERVER_ENTRY` mechanism (Phase 7.0). As of this
phase, `apps/web/src/index.ts` **self-computes** that path from its own
runtime location (`repoRoot`-relative, the same technique already used
for the static client directory) if the env var isn't explicitly set —
so it's correct on Railway's actual mount point without needing to guess
or hardcode it. Still overridable by setting the env var explicitly.

## Environment variables

Names and purpose only — no values here or ever printed by any tool call.
Set every value directly in Railway's dashboard/CLI, not by pasting into
chat.

### Required integration secrets

| Variable                 | Purpose                                                           | Same name/value as local `.env`? |
| ------------------------ | ----------------------------------------------------------------- | -------------------------------- |
| `ANTHROPIC_API_KEY`      | Claude API access                                                 | yes                              |
| `LINEAR_API_KEY`         | Linear read access (MCP subprocess)                               | yes                              |
| `LINEAR_API_KEY_WRITE`   | Linear issue creation; only needed with `DEMO_WRITE_MODE=enabled` | yes                              |
| `GITHUB_TOKEN`           | GitHub PR/CI read access                                          | yes                              |
| `SLACK_BOT_TOKEN`        | Slack read access                                                 | yes                              |
| `LINEAR_PROJECT_ID_ACME` | Project registry entry                                            | yes                              |
| `LINEAR_TEAM_ID_ACME`    | Project registry entry                                            | yes                              |
| `SLACK_CHANNEL_ID_ACME`  | Project registry entry                                            | yes                              |

### Required runtime configuration

| Variable          | Value           | Why                                                                                                                                                                                                                                                                                          |
| ----------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HOST`            | `0.0.0.0`       | The server defaults to `127.0.0.1` (a deliberate local-dev safety default) — Railway's proxy cannot reach a loopback-only bind. **Without this set, the deploy will build and pass a health check that never routes real traffic; verify it explicitly, not just that the build succeeded.** |
| `PORT`            | — (leave unset) | Railway injects this itself; the app already reads `process.env.PORT`. Do not set manually.                                                                                                                                                                                                  |
| `DEMO_WRITE_MODE` | `disabled`      | Public-demo write-safety policy — see decisions.md. Real writes happen only with the exact value `enabled`, so leaving it unset is also safe. Never set `enabled` on a public deploy: any visitor who gets a `proposalId` could write to Linear.                                             |

### Optional runtime configuration

| Variable                        | Default if unset          | Purpose                                                                                            |
| ------------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------- |
| `LINEAR_MCP_SERVER_ENTRY`       | self-computed (see above) | Override only for a non-standard layout.                                                           |
| `MAX_CONCURRENT_INVESTIGATIONS` | `1`                       | Global in-process concurrency cap on `/api/investigate` — see decisions.md.                        |
| `INVESTIGATION_TIMEOUT_MS`      | `240000`                  | Hard limit on one investigation.                                                                   |
| `AGENCY_DATA_DIR`               | repo root                 | Where `.traces/` and `.audit/` go. Point it at a Railway volume, or both are lost on every deploy. |
| `SLACK_WORKSPACE_URL`           | none                      | Makes Slack evidence link to the message, e.g. `https://acme.slack.com`.                           |

### Optional observability

| Variable                                                                | Purpose                                        |
| ----------------------------------------------------------------------- | ---------------------------------------------- |
| `OTEL_EXPORT_ENABLED`                                                   | Must be exactly `true` to export traces at all |
| `OTEL_EXPORTER_OTLP_ENDPOINT` (or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`) | Grafana Cloud Tempo OTLP endpoint              |
| `OTEL_EXPORTER_OTLP_HEADERS`                                            | Grafana Cloud auth header, `Key=Value` format  |

## Single-replica / in-memory-state limitation

V1 explicitly assumes exactly 1 replica. `ProposalStore` holds pending
action proposals in this one process's memory — a restart or a second
replica would each have their own, disjoint proposal state. Consequences,
by design, not bugs:

- A Railway restart (deploy, crash-restart, platform maintenance)
  invalidates every outstanding (undecided) proposal. A visitor who
  clicks Approve/Reject on a proposal from before the restart gets an
  honest `proposal_not_found` (404) — the existing error path, not a
  crash.
- Never set `numReplicas` above 1 for this service without first adding
  shared proposal storage — `railway.json` pins `numReplicas: 1`
  explicitly for this reason.
- No persistence is promised or needed for a portfolio demo: a lost
  in-flight proposal on restart is an acceptable, honestly-surfaced V1
  limitation, not silently swallowed.

## Public write-safety policy

See "Phase 7.4" in `docs/decisions.md` for the full threat model and
design. Summary: any `DEMO_WRITE_MODE` other than `enabled` makes a real approval get
recorded honestly (a human did approve) but never calls the real
`IssueWriter` — the UI shows "Approval recorded. External execution is
disabled in the public demo." instead of pretending a Linear issue was
created. The real write path needs `DEMO_WRITE_MODE=enabled` locally, and stays
available through the CLI, which doesn't read this variable.

## Abuse protection

A global, in-process concurrency cap (`MAX_CONCURRENT_INVESTIGATIONS`,
default 1) on `POST /api/investigate` — the excess request never reaches
`investigate()` (no Anthropic call), returning `429 {error:
{code:"demo_busy"}}` immediately. The UI shows "The demo is busy" with
the server's own message. **Limitations, reported plainly**: this is a
single-process in-memory counter, not per-IP or per-user — it stops
"100 simultaneous investigations" but not a slow drip of sequential
requests from one abusive visitor, and resets on restart. No rate
limiting beyond this, no auth, no Redis, no database — appropriate for a
single-user portfolio demo, not a multi-tenant product.

## Health endpoint

`GET /health` → `{"status":"ok"}`. Confirms only that the Node process is
alive and routing requests — it calls no external system (no Claude, no
MCP spawn, no Linear/GitHub/Slack) and returns no configuration or
secret information. Used as `railway.json`'s `healthcheckPath`.
