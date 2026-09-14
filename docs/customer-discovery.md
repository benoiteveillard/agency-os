# Customer discovery

## Customer

**Acme Digital** — a fictional 50-person digital agency running multiple
concurrent website/application projects for clients. All accounts are
dedicated demo/sandbox accounts; all data (customers, employees, projects,
conversations) is synthetic. Real SaaS APIs are used wherever practical, for
realistic auth, pagination, rate limits, and failure modes (README §1).

Toolset: Linear (project management), GitHub (development), Slack (internal
comms), HubSpot (CRM), optionally Webflow. Phase 1 covers Linear + GitHub
only (README §7).

## Workflow being replaced

A project manager currently reconstructs a project's status by manually
opening Linear, GitHub, Slack, and HubSpot in turn, reading each one, and
mentally correlating what they find. This is the workflow Agency OS
automates for a single question at a time, starting with:

> "What is blocking Project Acme?"

## Pain points

- Status information is fragmented across 3-4 systems with no single source
  of truth.
- Systems can disagree (e.g. Linear shows "deployment approved" while Slack
  discussion shows customer approval is still pending) — reconciling that
  today is manual and error-prone.
- Information goes stale (a Slack-reported blocker may already be resolved
  in Linear) and a manual read-through doesn't always catch that.
- Reconstructing status is repetitive: the same investigation happens every
  time someone asks "are we on track?"

## Stakeholders (per the fictional scenario)

- **Sarah Chen — Project Manager** — asks the status question, needs an
  answer they can act on and trust.
- **Alice Martin — Technical Lead** — owns engineering blockers (e.g. the
  CMS migration issue in the scenario).
- **Tom Becker — Frontend Developer** — implements the work tracked in
  Linear/GitHub; a likely assignee on blocking issues and PRs.
- **Emma Wilson — Account Manager** — owns the customer relationship and any
  customer-approval blockers. Not the same person as the project manager.
- **Client** — external, not a system user, but their approvals/decisions
  (tracked secondhand via Slack/HubSpot) can gate launch.

## Current process (manual)

1. Open Linear, scan the project's issues for anything critical/overdue/blocked.
2. Open GitHub, check open PRs and whether the production PR has been
   reviewed, and whether CI is green.
3. Search Slack for recent discussion that might contradict or add context
   to what Linear/GitHub show.
4. Check HubSpot for the deal's launch date, priority, and account owner.
5. Mentally correlate all of the above into a risk judgment.

Steps 1-2 are Phase 1's scope. 3-4 are explicitly deferred (Phase 2, Phase 6).

## Constraints

- Data must stay synthetic — no real customer/employee information, ever.
- Reads happen autonomously; anything that changes state in a real system
  requires human approval (README §4.3-4.4) — not yet relevant to Phase 1
  since nothing writes yet.
- External content (issue titles, PR descriptions, etc.) must be treated as
  untrusted data, never as instructions to the agent (README §4.5,
  Scenario E).
- Tool surface should stay small and business-shaped, not a generic
  "call any API" escape hatch (README §9).

## Success criteria for this milestone

From `apps/cli`, asking "What is blocking Project Acme?" produces an answer
that:

- names the specific blocking issue(s) by Linear identifier,
- names any PR(s) awaiting review or with failing CI by number,
- cites evidence (identifiers, URLs) rather than asserting unsupported
  conclusions,
- says so plainly if a tool call fails or a required project mapping is
  missing, rather than guessing.

## Questions an FDE would ask before going further

- Who is the actual audience for the eventual UI — the PM only, or also the
  technical lead and account owner? (Affects what "actionable" means.)
- When Linear and Slack disagree (Phase 2+), which system should be treated
  as authoritative by default, and does that vary by claim type (deployment
  status vs. customer approval vs. issue status)? README §19 sketches a
  starting position; it should be validated against how this agency actually
  operates before being hard-coded into prompts or logic.
- What counts as "blocking" precisely — any open critical issue, or only
  ones with an explicit `blocks` relation to a launch-critical issue? The
  current implementation surfaces both overdue issues and explicit
  Linear `blocks` relations; whether that matches a PM's mental model of
  "blocking" is worth checking against a real user, not just this project's
  synthetic scenario.
- Who is authorized to approve a deployment or customer sign-off in Slack
  (Scenario C, README §14)? This needs a real answer before Phase 2/3 can
  reason about authorization correctly — right now there is no notion of
  authorized approvers at all.
