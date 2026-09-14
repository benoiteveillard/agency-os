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

---

## Appending to `.env` without a trailing newline silently merged two variables

**Observed.** The Phase 3 approval-path live smoke test failed
`slack_get_channel_messages` with `channel_not_found`, quoting a channel ID
of `C0C1BPN0VFYLINEAR_TEAM_ID_ACME=9b0c50c9-5333-4d72-ac3c-fd5aa28f6313` —
visibly two values concatenated together, not a real Slack channel ID.

**Expected.** `SLACK_CHANNEL_ID_ACME` and `LINEAR_TEAM_ID_ACME` should have
been two independent, correctly-parsed variables.

**Root cause.** An earlier `echo "LINEAR_TEAM_ID_ACME=..." >> .env` command
appended to a file that did not end in a newline. `echo`'s own trailing
newline came *after* the appended text, not before it — so the new
variable's text landed on the same line as whatever the previous line's
last variable was (`SLACK_CHANNEL_ID_ACME`), silently merging them into one
corrupted value. `wc -l` and a name-only `grep -oE '^[A-Z_]+'` both looked
correct at the time (line count unchanged, `LINEAR_TEAM_ID_ACME` simply
didn't show up as its own line yet) — the corruption wasn't visible until
something actually tried to *use* the corrupted value against a real API.
A second append later (`printf '%s\n' ... >> .env`, used after noticing the
first attempt seemingly "didn't take") added a clean, correctly-terminated
line — but never touched or repaired the already-corrupted line, so both
problems coexisted undetected until this live run surfaced it.

**Fix.** Corrected the specific `.env` line via `sed`, restoring
`SLACK_CHANNEL_ID_ACME` to its real 11-character value and leaving
`LINEAR_TEAM_ID_ACME` as its own clean line.

**Evaluation added.** None — this is a one-time local data-entry accident,
not an agent-behavior scenario. Recorded as a reusable pattern instead:
**appending to `.env` (or any line-oriented config file) with a plain shell
redirect is only safe if the file already ends in a newline; verify with
`printf '%s\n' ... >> file` and a value-length check (not just a line-count
or key-name check) rather than assuming the append landed cleanly.** A
line-count-only sanity check would have missed this entirely, since the
corrupted line still counted as exactly one line.

**Result.** Fixed and verified: the Slack tool calls succeeded on the next
live run, and the rest of that run (rejection-path smoke test) completed
normally. Also a reminder of why `docs/decisions.md`'s "verify empirically,
don't assume a fix landed" discipline should extend to the agent's own
setup steps, not just to external API behavior.

---

## An unrequested "thinking" block let the highest-stakes eval judge call pass vacuously

**Observed.** During the first Phase 5 full-suite run, several
`evidence_grounding` trials reported `"failed items: judge response
unparsable"`. That was visible and got investigated immediately. What
wasn't visible without investigating: the exact same root cause meant
`grade_adversarial_robustness`'s injection-compliance judge call — the one
call in the entire suite specifically double-invoked to catch
disagreement, because it's the highest-stakes safety judgment in the
report — had also been returning empty strings on every call, which
`"".lower().startswith("yes")` silently evaluates to `False`. Both calls
agreeing on `False` looked identical to "the judge checked and found no
compliance." It had not checked anything.

**Expected.** A judge call either produces a scoreable answer or the
grader treats it as a failure to grade — never as a specific, positive
"no problem found" result.

**Root cause.** `claude-sonnet-5` emits an unrequested `thinking` content
block by default — no `thinking` parameter was ever passed. At a modest
`max_tokens` (200 for rubric scoring, 10 for the yes/no injection-compliance
check), the thinking block alone could consume the entire budget, leaving
`stop_reason: "max_tokens"` and zero text blocks in the response. Confirmed
directly: a reproduction of the exact rubric-scoring prompt at
`max_tokens=200` came back with one `ThinkingBlock` (199 of 200 tokens) and
no text at all. `evidence_grounding`'s failure mode surfaced this
(`rubric_score` returning `{}` on unparseable JSON, which `graders.py`
already treated as a failure — safe by construction). `adversarial_robustness`'s
failure mode did not surface it: `injection_compliance_check` returned a
plain `bool`, so an empty string collapsed into `False` — a valid-looking
"no" — with no way to distinguish it from a real "no".

**Fix.** Two changes, not one:
1. Pass `thinking={"type": "disabled"}` on every judge call
   (`evals/judge.py`) — confirmed directly against the SDK's
   `ThinkingConfigDisabledParam` type before relying on it, then verified
   the same rubric prompt returns real text with it set.
2. Changed `injection_compliance_check`'s return type from `bool` to a
   tri-state `"yes" | "no" | "error"` — an empty or unparseable response is
   now `"error"`, handled in `graders.py` as its own reported outcome
   (`judge_error`), distinct from and never collapsed into a valid `"no"`.
   `rubric_score` and `classify_conclusion` already failed safe on empty
   input (`{}` and `"other"` respectively, neither of which can satisfy a
   pass condition) — audited and confirmed, not just assumed, before
   deciding they didn't need the same tri-state treatment.

**Evaluation added.** `evals/regression/test_judge_failure_modes.py` — six
assertions, no network call (monkeypatches `judge._call`), proving an
empty or unparseable judge response can never be interpreted as a pass or
as "no compromise detected" for any of the three judge functions. Runs in
under a second, so there's no cost excuse for this regressing silently
again. A second, network-dependent regression
(`evals/regression/test_grounding_rubric.py`) covers a related but
separate rubric-wording bug found in the same run — see `docs/evaluation.md`.

**Result.** Fixed and verified: the full suite was rerun after the fix,
`evidence_grounding` no longer produces any unparseable result, and
`prompt_injection_in_slack` (which exercises the double injection-compliance
call on every trial) continued to pass 5/5 — this time because the judge
actually returned real, scoreable text, confirmed by inspecting raw output
tokens per call before and after the fix (2176 → 826 total output tokens
across the same 66 calls, consistent with thinking tokens no longer being
silently burned).
