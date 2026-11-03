import { useEffect, useState } from "react";
import { useProposalDecision } from "../hooks/useProposalDecision.js";
import type { AuditDTO, Evidence, ProposalPresentation } from "../types.js";
import { EvidenceCitation } from "./BlockerList.js";
import { Icon, type IconName } from "./Icon.js";

const PRIORITY_LABEL: Record<number, string> = {
  0: "None",
  1: "Urgent",
  2: "High",
  3: "Medium",
  4: "Low",
};

const EXPIRED_COPY =
  "This recommendation expired. Run the investigation again before approving it.";

const ERROR_COPY: Record<string, string> = {
  proposal_not_found: "This recommendation could not be found.",
  proposal_expired: EXPIRED_COPY,
  proposal_already_decided: "This recommendation has already been decided.",
  proposal_in_progress:
    "Still processing this decision. Wait a moment and try again.",
  execution_failed:
    "The action could not be confirmed. It will not be retried automatically.",
  proposal_execution_failed:
    "The action could not be confirmed. It will not be retried automatically.",
  network_error:
    "Your decision may or may not have been recorded. Retrying is safe and won't repeat an action that already ran.",
};

const ERROR_TITLE: Record<string, string> = {
  proposal_expired: "This proposal expired",
  network_error: "Connection dropped",
};

/** Retrying is safe for these: the server treats a repeated decision as idempotent. */
const RETRYABLE_ERRORS = new Set(["proposal_in_progress", "network_error"]);

const HOUR_S = 3600;

function useSecondsLeft(expiresAt: string, active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return Math.max(0, Math.ceil((new Date(expiresAt).getTime() - now) / 1000));
}

function Outcome({
  tone,
  icon,
  title,
  children,
}: {
  tone: "success" | "neutral" | "warning" | "failure";
  icon: IconName;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`outcome outcome--${tone}`} role="status">
      <Icon name={icon} />
      <div>
        <strong>{title}</strong>
        {children}
      </div>
    </div>
  );
}

export function ProposalCard({
  proposal,
  evidenceById,
  alreadyQuoted,
}: {
  proposal: ProposalPresentation;
  evidenceById: Map<string, Evidence>;
  /** Evidence whose excerpt a blocker on this page already shows. */
  alreadyQuoted?: Set<string>;
}) {
  const { state, decide } = useProposalDecision(proposal.proposalId);
  const busy = state.phase === "deciding";
  const pending = state.phase === "pending" || busy;
  const secondsLeft = useSecondsLeft(proposal.expiresAt, pending);
  // Display only: the server enforces expiry whatever this clock says.
  const expired = pending && secondsLeft === 0;

  return (
    <section
      className="decision"
      id="decision"
      aria-labelledby="decision-heading"
    >
      <div className="decision__head">
        <h3 id="decision-heading">Your decision</h3>
        {pending && !expired && secondsLeft < HOUR_S && (
          <span className="decision__expiry">
            <Icon name="Clock" small />
            Expires in {Math.floor(secondsLeft / 60)}:
            {String(secondsLeft % 60).padStart(2, "0")}
          </span>
        )}
      </div>

      <div className="decision__draft">
        <p className="decision__draft-label">
          If you approve, this exact issue goes to Linear
        </p>
        <p className="decision__title">{proposal.title}</p>
        <p className="decision__description">{proposal.description}</p>
        <p className="decision__fields">
          <span>Project: {proposal.projectName}</span>
          <span>
            Priority: {PRIORITY_LABEL[proposal.priority] ?? proposal.priority}
          </span>
        </p>
      </div>

      <div className="decision__why">
        <p>
          <strong>Why this action.</strong> <span>{proposal.rationale}</span>
        </p>
        <ul aria-label="Evidence for this action">
          {proposal.evidenceIds.map((evidenceId) => (
            <li key={evidenceId}>
              <EvidenceCitation
                evidenceId={evidenceId}
                evidence={evidenceById.get(evidenceId)}
                quote={!alreadyQuoted?.has(evidenceId)}
              />
            </li>
          ))}
        </ul>
      </div>

      {expired && !busy ? (
        <Outcome tone="failure" icon="Clock" title="This proposal expired">
          <span>{EXPIRED_COPY}</span>
        </Outcome>
      ) : pending ? (
        <>
          <div className="decision__actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={() => decide("approve")}
            >
              {busy && state.decision === "approve"
                ? "Approving"
                : "Approve and create issue"}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={busy}
              onClick={() => decide("reject")}
            >
              {busy && state.decision === "reject" ? "Rejecting" : "Reject"}
            </button>
          </div>
          <p className="decision__note">
            In the public demo, approval may be recorded without creating the
            issue.
          </p>
        </>
      ) : state.phase === "decided" ? (
        <DecidedStatus audit={state.audit} projectName={proposal.projectName} />
      ) : (
        <Outcome
          tone={RETRYABLE_ERRORS.has(state.error.code) ? "warning" : "failure"}
          icon={state.error.code === "network_error" ? "WifiOff" : "Cross"}
          title={
            ERROR_TITLE[state.error.code] ?? "This decision did not complete"
          }
        >
          <span>{ERROR_COPY[state.error.code] ?? state.error.message}</span>
          {RETRYABLE_ERRORS.has(state.error.code) && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => decide(state.decision)}
            >
              Retry
            </button>
          )}
        </Outcome>
      )}
    </section>
  );
}

function DecidedStatus({
  audit,
  projectName,
}: {
  audit: AuditDTO;
  projectName: string;
}) {
  if (audit.decision === "rejected") {
    return (
      <Outcome tone="neutral" icon="Cross" title="Rejected">
        <span>
          No change was made in Linear. Your decision is in the audit log.
        </span>
      </Outcome>
    );
  }
  const outcome = audit.execution?.outcome;
  if (outcome === "success") {
    const issue = audit.execution?.createdIssue;
    return (
      <Outcome tone="success" icon="Check" title="Approved and created">
        <span>
          {issue ? (
            <>
              Linear issue{" "}
              {issue.url ? (
                <a href={issue.url} target="_blank" rel="noreferrer noopener">
                  {issue.identifier}
                </a>
              ) : (
                issue.identifier
              )}{" "}
              now exists in {projectName}.
            </>
          ) : (
            `The issue now exists in ${projectName}.`
          )}
        </span>
      </Outcome>
    );
  }
  if (outcome === "executed_unconfirmed") {
    return (
      <Outcome
        tone="warning"
        icon="Warning"
        title="Approved, but not confirmed"
      >
        <span>
          The issue may have been created. Check Linear before doing anything
          else.
        </span>
      </Outcome>
    );
  }
  if (outcome === "execution_disabled") {
    return (
      <Outcome tone="neutral" icon="Check" title="Approval recorded">
        <span>
          Writing to Linear is disabled in this demo, so no issue was created.
        </span>
      </Outcome>
    );
  }
  return (
    <Outcome tone="failure" icon="Cross" title="Approved, but not completed">
      <span>
        The action was not confirmed. It will not be retried automatically.
      </span>
    </Outcome>
  );
}
