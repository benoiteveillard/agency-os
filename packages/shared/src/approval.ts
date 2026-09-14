import { createHash } from "node:crypto";

/**
 * Phase 3 supports exactly one write capability, so this is intentionally
 * a single concrete shape, not a discriminated union. Generalize
 * ProposedAction/AuditRecord into a union only once a second write
 * capability actually exists (AGENTS.md #42 — no premature abstraction).
 */
export interface LinearCreateIssueArgs {
  teamId: string;
  projectId: string;
  title: string;
  description: string;
  /** Linear's 0-4 scale: 0=None, 1=Urgent, 2=High, 3=Medium, 4=Low. */
  priority: number;
  /**
   * Client-supplied UUID passed as Linear's IssueCreateInput.id. Kept as an
   * experiment, not relied on for idempotency — Linear's docs don't confirm
   * whether reusing an id dedupes, rejects, or is ignored. See
   * docs/decisions.md before treating this as a guarantee.
   */
  id: string;
}

export interface ProposedAction {
  /** Proposal/audit identifier — distinct from args.id (the Linear-side experiment above). */
  id: string;
  kind: "linear_create_issue";
  args: Readonly<LinearCreateIssueArgs>;
  rationale: string;
  proposedAt: string;
  /**
   * sha256 hex digest over canonical JSON of exactly {kind, args} — the
   * application invariant "what was approved === what is executed" is
   * enforced by recomputing and comparing this immediately before
   * execution (packages/agent/src/approval.ts), not by object identity or
   * Object.freeze alone.
   */
  approvalDigest: string;
}

export interface CreatedIssueSummary {
  id: string;
  identifier: string;
  title: string;
  url: string;
}

export interface AuditRecord {
  proposalId: string;
  kind: "linear_create_issue";
  args: Readonly<LinearCreateIssueArgs>;
  approvalDigest: string;
  rationale: string;
  proposedAt: string;
  decision: "approved" | "rejected";
  decidedAt: string;
  /** Present only when decision is "approved". */
  execution?: {
    startedAt: string;
    outcome: "success" | "failure" | "executed_unconfirmed";
    error?: string;
    /** From reading the issue back after creation, not from the write response. */
    createdIssue?: CreatedIssueSummary;
  };
}

/** Read-only-write port: the one write capability this phase adds. */
export interface IssueWriter {
  createIssue(args: LinearCreateIssueArgs): Promise<{ issueId: string }>;
}

/** Returns true to approve, false to reject. Application-controlled — never the model. */
export type ApprovalPrompt = (action: ProposedAction) => Promise<boolean>;

/**
 * Deterministic digest over {kind, args}, used to bind an approval decision
 * to the exact payload a human saw. Small, hand-rolled canonical JSON
 * (sorted object keys, no whitespace) rather than a library — the payload
 * here is always a plain object of strings/numbers, so this doesn't need
 * to handle dates, undefined-in-arrays, or other edge cases a general
 * canonicalizer would.
 */
export function computeApprovalDigest(kind: string, args: unknown): string {
  return createHash("sha256")
    .update(canonicalJson({ kind, args }))
    .digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${entries.join(",")}}`;
}
