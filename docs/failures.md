# Failures

Format per README §22: observed behavior, expected behavior, root cause, fix,
evaluation added, result. Documented here because AGENTS.md #27 requires it
when a failure teaches something reusable — not for every bug.

## `pnpm ask` couldn't find `.env` (root cause: pnpm changes cwd for filtered scripts)

**Observed.** `pnpm ask "What is blocking Project Acme?"` failed immediately
with `Missing required environment variable: ANTHROPIC_API_KEY`, even though
`.env` existed at the repo root with all four variables set.

**Expected.** The CLI should pick up `.env` from the repo root regardless of
how it's invoked.

**Root cause.** `apps/cli/src/index.ts` used `import "dotenv/config"`, which
resolves `.env` relative to `process.cwd()`. The root `ask` script is
`pnpm --filter @agency-os/cli start --`, and `pnpm --filter <pkg> run
<script>` executes with `cwd` set to that package's directory
(`apps/cli/`), not the repo root — so dotenv silently looked for
`apps/cli/.env`, found nothing, and left `process.env` unset. No error was
raised at the dotenv layer; it fails open.

**Fix.** `apps/cli/src/index.ts` now resolves the repo root from the
module's own file location (`fileURLToPath(import.meta.url)`, three
directories up) and passes that explicit path to `dotenv`'s `config()`,
rather than relying on `cwd`.

**Evaluation added.** None yet — Phase 5's evaluation suite doesn't exist
yet. This is an infrastructure/tooling failure, not an agent-behavior
scenario, so it doesn't fit the eval framework's shape (it has no bearing on
model reasoning). It's recorded here instead as a reusable pattern: **in a
pnpm workspace, anything that loads `.env` via a cwd-relative default inside
a package invoked through `--filter` will silently misbehave** — worth
checking first if a similar symptom (env var "missing" despite being set)
recurs elsewhere in this repo.

**Result.** Fixed and verified: rerunning `pnpm ask "..."` after the fix
successfully loaded all four variables and completed the live smoke test
(see `docs/decisions.md` / the Phase 1 smoke-test report for that run).
