import { useProposalDecision } from "../hooks/useProposalDecision.js";
import type { AuditDTO, ProposalPresentation } from "../types.js";

const PRIORITY_LABEL: Record<number, string> = {
  0: "None",
  1: "Urgent",
  2: "High",
  3: "Medium",
  4: "Low",
};

const ERROR_COPY: Record<string, string> = {
  proposal_not_found: "This recommendation could not be found.",
  proposal_expired:
    "This recommendation expired. Run the investigation again before approving it.",
  proposal_already_decided: "This recommendation has already been decided.",
  proposal_in_progress:
    "Still processing this decision — please wait a moment and try again.",
  execution_failed:
    "The action could not be confirmed. It will not be retried automatically.",
  proposal_execution_failed:
    "The action could not be confirmed. It will not be retried automatically.",
};

export function ProposalCard({ proposal }: { proposal: ProposalPresentation }) {
  const { state, decide } = useProposalDecision(proposal.proposalId);
  const busy = state.phase === "deciding";

  return (
    <section className="proposal-card" aria-labelledby="proposal-title">
      <p className="proposal-card__eyebrow">Recommended action</p>
      <h3 id="proposal-title" className="proposal-card__title">
        {proposal.title}
      </h3>
      <p className="proposal-card__description">{proposal.description}</p>
      <p className="proposal-card__disclaimer">
        Priority: {PRIORITY_LABEL[proposal.priority] ?? proposal.priority}. The
        agent can create this follow-up in Linear, but requires your approval
        first — it cannot execute this on its own.
      </p>

      {state.phase === "pending" || state.phase === "deciding" ? (
        <div className="proposal-card__actions">
          <button
            type="button"
            className="btn btn-ghost"
            disabled={busy}
            onClick={() => decide("reject")}
          >
            {busy && state.decision === "reject" ? "Rejecting…" : "Reject"}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() => decide("approve")}
          >
            {busy && state.decision === "approve"
              ? "Approving…"
              : "Approve action"}
          </button>
        </div>
      ) : state.phase === "decided" ? (
        <DecidedStatus audit={state.audit} />
      ) : (
        <div className="proposal-card__actions proposal-card__actions--stacked">
          <p className="proposal-status proposal-status--failure">
            {ERROR_COPY[state.error.code] ?? state.error.message}
          </p>
          {state.error.code === "proposal_in_progress" && (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => decide("approve")}
            >
              Retry
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function DecidedStatus({ audit }: { audit: AuditDTO }) {
  if (audit.decision === "rejected") {
    return (
      <p className="proposal-status proposal-status--rejected">
        Action rejected — no changes were made.
      </p>
    );
  }
  const outcome = audit.execution?.outcome;
  if (outcome === "success") {
    return (
      <p className="proposal-status proposal-status--success">
        Approved and created
        {audit.execution?.createdIssue ? (
          <>
            {" — "}
            {audit.execution.createdIssue.url ? (
              <a
                href={audit.execution.createdIssue.url}
                target="_blank"
                rel="noreferrer noopener"
              >
                {audit.execution.createdIssue.identifier}
              </a>
            ) : (
              audit.execution.createdIssue.identifier
            )}
          </>
        ) : null}
      </p>
    );
  }
  if (outcome === "executed_unconfirmed") {
    return (
      <p className="proposal-status proposal-status--unconfirmed">
        Approved. The write may have gone through, but it could not be confirmed
        — check Linear directly.
      </p>
    );
  }
  return (
    <p className="proposal-status proposal-status--failure">
      Approved, but the action was not confirmed. It will not be retried
      automatically.
    </p>
  );
}
