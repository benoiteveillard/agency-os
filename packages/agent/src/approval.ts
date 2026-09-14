import type { IssueTracker } from "@agency-os/integration-linear";
import {
  computeApprovalDigest,
  type ApprovalPrompt,
  type AuditRecord,
  type IssueWriter,
  type ProposedAction,
} from "@agency-os/shared";

export interface ReviewAndExecuteDeps {
  promptForApproval: ApprovalPrompt;
  issueWriter: IssueWriter;
  /** Reused for the post-write read-back — the same read path already built and tested in Phase 1. */
  issueTracker: IssueTracker;
}

/**
 * The only function in this codebase that can call IssueWriter.createIssue.
 * Called by apps/cli, after investigate() has already returned and the
 * model's turn has ended — never by runner.ts, never reachable from a
 * tool_use block. This is the enforcement point AGENTS.md #15 asks for:
 * approval lives in application logic, not a system-prompt instruction.
 */
export async function reviewAndExecute(
  action: ProposedAction,
  deps: ReviewAndExecuteDeps,
): Promise<AuditRecord> {
  const base = {
    proposalId: action.id,
    kind: action.kind,
    args: action.args,
    approvalDigest: action.approvalDigest,
    rationale: action.rationale,
    proposedAt: action.proposedAt,
  };

  const approved = await deps.promptForApproval(action);
  if (!approved) {
    return {
      ...base,
      decision: "rejected",
      decidedAt: new Date().toISOString(),
    };
  }

  const decidedAt = new Date().toISOString();

  // The actual "what was approved === what is executed" check: recompute
  // the digest from exactly what's about to run and refuse on any
  // mismatch. Object.freeze() (applied where the proposal is built) is
  // defense in depth, not the guarantee itself — this comparison is.
  const recomputed = computeApprovalDigest(action.kind, action.args);
  if (recomputed !== action.approvalDigest) {
    return {
      ...base,
      decision: "approved",
      decidedAt,
      execution: {
        startedAt: new Date().toISOString(),
        outcome: "failure",
        error:
          "Approval digest mismatch: the action differs from what was approved. Execution refused.",
      },
    };
  }

  const startedAt = new Date().toISOString();
  let issueId: string;
  try {
    ({ issueId } = await deps.issueWriter.createIssue(action.args));
  } catch (err) {
    return {
      ...base,
      decision: "approved",
      decidedAt,
      execution: {
        startedAt,
        outcome: "failure",
        error: (err as Error).message,
      },
    };
  }

  try {
    const created = await deps.issueTracker.getIssue(issueId);
    return {
      ...base,
      decision: "approved",
      decidedAt,
      execution: {
        startedAt,
        outcome: "success",
        createdIssue: {
          id: created.id,
          identifier: created.identifier,
          title: created.title,
          url: created.url,
        },
      },
    };
  } catch (err) {
    // The write itself succeeded (we have an issueId) — only the
    // read-back failed. Reporting this as outright "failure" would be a
    // false negative; reporting plain "success" would overstate what we
    // actually confirmed. Neither is honest, so it gets its own outcome.
    return {
      ...base,
      decision: "approved",
      decidedAt,
      execution: {
        startedAt,
        outcome: "executed_unconfirmed",
        error: (err as Error).message,
      },
    };
  }
}
