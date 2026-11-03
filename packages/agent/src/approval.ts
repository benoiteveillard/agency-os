import type { IssueTracker } from "@agency-os/integration-linear";
import {
  categorizeError,
  truncateErrorMessage,
  type Span,
  type Tracer,
} from "@agency-os/observability";
import {
  bounded,
  computeApprovalDigest,
  TimeoutError,
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
  /** Same trace as investigate() — see apps/cli/src/index.ts, which owns both the tracer and the agent.run root span passed as parentSpan. */
  tracer: Tracer;
  parentSpan: Span;
  /**
   * Server-owned public-demo write policy (Phase 7.4). Defaults to true —
   * only apps/web sets this from DEMO_WRITE_MODE, never from any
   * client-supplied value. When false, an approval is still recorded
   * honestly (the human really did approve it) but issueWriter.createIssue
   * is never called — this is the one place that gate is enforced, same
   * as the digest check below.
   */
  writesEnabled?: boolean;
  /** Limit on the write and on its read-back. Overridable for tests. */
  externalCallTimeoutMs?: number;
}

const EXTERNAL_CALL_TIMEOUT_MS = 30_000;

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
    evidenceIds: action.evidenceIds,
    proposedAt: action.proposedAt,
  };

  const approvalSpan = deps.tracer.startSpan("approval.decision", "approval", {
    parent: deps.parentSpan,
    attributes: { proposalId: action.id, kind: action.kind },
  });
  let approved: boolean;
  try {
    approved = await deps.promptForApproval(action);
  } catch (err) {
    const message = (err as Error).message;
    approvalSpan.end("error", {
      category: categorizeError(message),
      message: truncateErrorMessage(message),
    });
    throw err;
  }
  approvalSpan.setAttribute("decision", approved ? "approved" : "rejected");
  approvalSpan.end("ok");

  if (!approved) {
    return {
      ...base,
      decision: "rejected",
      decidedAt: new Date().toISOString(),
    };
  }

  const decidedAt = new Date().toISOString();

  const executeSpan = deps.tracer.startSpan("action.execute", "action", {
    parent: deps.parentSpan,
    attributes: { proposalId: action.id, kind: action.kind },
  });

  if (deps.writesEnabled === false) {
    executeSpan.setAttribute("outcome", "execution_disabled");
    executeSpan.end("ok");
    return {
      ...base,
      decision: "approved",
      decidedAt,
      execution: {
        startedAt: new Date().toISOString(),
        outcome: "execution_disabled",
      },
    };
  }

  // The actual "what was approved === what is executed" check: recompute
  // the digest from exactly what's about to run and refuse on any
  // mismatch. Object.freeze() (applied where the proposal is built) is
  // defense in depth, not the guarantee itself — this comparison is.
  const recomputed = computeApprovalDigest(action.kind, action.args);
  if (recomputed !== action.approvalDigest) {
    const error =
      "Approval digest mismatch: the action differs from what was approved. Execution refused.";
    executeSpan.end("error", { category: "digest_mismatch", message: error });
    return {
      ...base,
      decision: "approved",
      decidedAt,
      execution: {
        startedAt: new Date().toISOString(),
        outcome: "failure",
        error,
      },
    };
  }

  const startedAt = new Date().toISOString();
  const timeoutMs = deps.externalCallTimeoutMs ?? EXTERNAL_CALL_TIMEOUT_MS;
  let issueId: string;
  try {
    ({ issueId } = await bounded(deps.issueWriter.createIssue(action.args), {
      timeoutMs,
      message: `Linear write timed out after ${timeoutMs}ms; it may still have taken effect.`,
    }));
  } catch (err) {
    const message = (err as Error).message;
    executeSpan.end("error", {
      category: categorizeError(message),
      message: truncateErrorMessage(message),
    });
    return {
      ...base,
      decision: "approved",
      decidedAt,
      execution: {
        startedAt,
        // A write that timed out wasn't necessarily refused: the request may
        // have landed, so "failure" would claim more than is known.
        outcome:
          err instanceof TimeoutError ? "executed_unconfirmed" : "failure",
        error: message,
      },
    };
  }
  executeSpan.setAttribute("issueId", issueId);
  executeSpan.end("ok");

  const confirmSpan = deps.tracer.startSpan("action.confirm", "action", {
    parent: deps.parentSpan,
    attributes: { issueId },
  });
  try {
    const created = await bounded(deps.issueTracker.getIssue(issueId), {
      timeoutMs,
      message: `Read-back timed out after ${timeoutMs}ms.`,
    });
    confirmSpan.setAttribute("identifier", created.identifier);
    confirmSpan.end("ok");
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
    const message = (err as Error).message;
    confirmSpan.end("error", {
      category: categorizeError(message),
      message: truncateErrorMessage(message),
    });
    return {
      ...base,
      decision: "approved",
      decidedAt,
      execution: {
        startedAt,
        outcome: "executed_unconfirmed",
        error: message,
      },
    };
  }
}
