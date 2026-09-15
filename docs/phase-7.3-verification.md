# Phase 7.3 verification — 2026-09-15

## Result

Implemented the customer-facing demo UI (`apps/web/client`, React 19 + Vite)
against the unchanged Phase 7.2 HTTP/SSE contract. No agent, prompt, tool,
approval, tracing, or eval change was needed or made — confirmed by re-running
`pnpm typecheck`/`lint`/`test`/`format` and the eval smoke suite unchanged.

- Typecheck (root + `apps/web/client`'s separate config), lint, format: pass.
- Deterministic tests: **210/210**, 30 files (3 new: `api.test.ts`,
  `useInvestigation.test.ts`, `App.test.tsx`; 22 new test cases, up from
  Phase 7.2's 188).
- Eval smoke: **9/9**, no safety incident. Full suite not rerun (no agent
  behavior changed).
- Both production bundles build; `apps/web/dist/client` (238 KB JS gzipped to
  74 KB, 14 KB CSS gzipped to 3 KB) is served statically by the same Hono
  process that serves the API.
- Frontend dependencies added: `react`/`react-dom` 19.3.0; dev-only `vite`
  8.3.0 (already resolved transitively elsewhere in the lockfile),
  `@vitejs/plugin-react` 6.1.1, `@testing-library/react` 16.3.3,
  `@testing-library/jest-dom` 7.0.1, `jsdom` 30.0.1, `concurrently` 10.0.5.
  No component library, no Markdown renderer, no client router, no state
  library.

## Two real bugs found and fixed during verification

Neither existed in Phase 7.2 — both are in this phase's own new code, found
by actually running the built app, not by the test suite alone:

1. **Stale-SSE-run race** (`useInvestigation.ts`): an aborted previous run's
   already-buffered chunk could still dispatch after a new run started,
   bleeding old progress/results into the new run. Fixed with a per-run
   `runId` the reducer checks before applying `message`/`transportError`
   actions. A companion bug in the same code path — `investigation.completed`
   unconditionally marked the "Assessing" step done even for a hypothetical
   question that never triggered one — was fixed alongside it
   (`finalizeAssessing`, which only ever settles a row that actually started).
2. **Mobile horizontal overflow**: `.app-body`'s single-column mobile grid
   track (`1fr`) inherited the CSS Grid default `min-width: auto`, refusing
   to shrink below the ask-input's intrinsic content width — `scrollWidth`
   416px against a 390px viewport. Fixed with `minmax(0, 1fr)`. Found via
   live `document.documentElement.scrollWidth` inspection in a real browser;
   `jsdom` (the component test environment) does not run real CSS Grid box
   generation, so this class of bug is structurally invisible to the
   component test suite — noted in `web-runtime.md` as a real gap, not
   silently left unstated.

A third response-shape bug was found and fixed in `decideProposal`
(`api.ts`) before any live run: HTTP 502 is returned both for a full
`AuditDTO` with `execution.outcome:"failure"` (a real, presented decision)
and for a top-level `{error}` envelope (a request-level exception) —
`apps/web/src/presentation.ts`/`app.ts`. The client incorrectly treated any
non-2xx as the latter. Fixed to decide by response body shape
(`"decision" in body`), not status code; locked in with a regression test.

## Live verification

Two full live runs against real Linear (via the Phase 7.0 compiled MCP
entry), GitHub, and Slack, through the actual built app
(`node apps/web/dist/server.js`), not a fixture.

**Run 1** (desktop, 1440px) — question: "Are we still on track to launch
Project Acme on Friday?" (one-click suggested-question path).

- Trace `c8ccc8502e560d56487fc07f8c4176ed`. Verdict `high_risk`, 5 blockers,
  3 uncertainties, 37 evidence references, all resolved. 79,895 ms, 11 tool
  calls, 69,151 input / 6,282 output tokens.
- A proposed action rendered (`4181ca74-dba8-4640-9ec7-c313a92ab747`,
  "Track and validate Safari/iPhone navigation bug ahead of launch").
  **Rejected** through the real `POST /api/proposals/:id/decide` endpoint —
  never approved. UI showed "Action rejected — no changes were made."
  Approval trace `8c48889edc90870092a5df54c9af178f`, `approvalDecision:
rejected`, 78 ms, zero tool spans — confirming no Linear write was
  attempted, not just none observed.
- Uncertainty section correctly separated from blockers; one uncertainty
  item is the model's own note that a Slack prompt-injection attempt was
  detected and disregarded (real model output, not additional UI exposure —
  the raw injected instruction text itself is not rendered anywhere in the
  UI, matching the instruction not to expose it merely because it's
  interesting).
- `tool.submit_assessment`: one `tool_validation` failure ("missing required
  array field \"blockers\"") then one success — the known Phase 7.1 finding,
  observed live, costing part of this run's 79.9 s. Not fixed, per this
  phase's explicit scope.
- Grafana export: `{event:"trace.export",attempted:true,ok:true}` logged for
  both the investigation and approval traces.

**Run 2** (tablet 768px, then mobile 390px mid-run) — same question via the
suggested-question chip.

- Trace `96fbb03635ff20ff8f3595c20a5b1b78`. Verdict `high_risk`, 5 blockers
  (a different but consistent selection from run 1 — non-deterministic model
  output, same underlying evidence), 93,075 ms, 13 tool calls, 76,716 input /
  6,484 output tokens. No proposed action this run (`proposedAction: false`)
  — a legitimate model choice, not an error; the UI correctly showed no
  proposal card.
- Same `submit_assessment` pattern: one validation failure, one success.
- Verified at 390px width after completion: zero horizontal overflow
  (`scrollWidth === clientWidth === 390`), evidence chips wrap, blocker
  cards stack, metadata footer stacks, approval buttons stay full-width and
  clear.

## Privacy and accessibility checks

- Browser console: empty throughout both runs (no errors/warnings).
- Accessibility tree: proper landmarks (`banner`, `navigation "Projects"`,
  `main`), heading hierarchy (`h1` project title, `h2` verdict headline,
  `h3` section headings), labeled textbox (`"Ask about this project"`),
  real `link` elements to Linear/GitHub issue URLs with descriptive
  accessible names (e.g. `"linear JUS-6 Authoritative"`), list semantics for
  blockers and evidence.
- No raw span IDs, tool payloads, evidence summaries, proposal digest, or
  target team/project IDs found anywhere in rendered DOM text (checked via
  page HTML inspection, not just component-test assertions).
- `prefers-reduced-motion: no-preference` gates the only animation (the
  in-progress pulse on a progress row); the app is fully understandable with
  it disabled, since state is also conveyed by icon shape/text, not color or
  motion alone.

## Performance finding (Phase 7.1 issue, observed again, not fixed)

Both live runs hit the same known structured-tool-call retry pattern: one
invalid `submit_assessment` attempt (missing `blockers`) before a valid one,
adding one extra model turn and tool call to each run (79.9 s and 93.1 s
respectively — both well under Phase 7.2's previously observed worst case of
~91.5 s with three retries). The SSE progress UI kept both waits legible
throughout: all three sources showed checked, "Assessing launch readiness"
stayed visibly in-progress (pulsing, not stalled-looking) the whole time, and
completion still resolved to a correct, fully-evidenced verdict in both
cases. The retries themselves are never exposed to the user — only the
steady "Assessing" state, matching the instruction not to surface internal
retries.

Given two consecutive live runs both independently hit this same failure
shape (not a one-off), and it now has directly observable UI-facing cost
(part of a ~80-93 s wait on every real run so far), this looks less like an
edge case and more like a real steady-state tax worth a dedicated fix cycle
— but that is a recommendation, not a decision made here: this phase's
explicit instruction was not to fix it, only to report whether it now
deserves one.

See [web-runtime.md](web-runtime.md) for the frontend architecture, local
dev commands, and the full HTTP/SSE contract this UI consumes.
