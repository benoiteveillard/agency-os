import type { ProposedAction } from "./approval.js";

/**
 * A single retrieved fact backing part of the agent's answer.
 * Every important claim in a final answer should trace back to at least one of these.
 */
export interface Evidence {
  source: "linear" | "github" | "slack";
  /** Provider-native identifier (e.g. Linear issue identifier, PR number) so a human can look it up. */
  id: string;
  url?: string;
  summary: string;
  timestamp?: string;
}

/** One tool invocation within an investigation, kept for future tracing/observability. */
export interface ToolCallRecord {
  tool: string;
  input: unknown;
  ok: boolean;
  durationMs: number;
  error?: string;
}

/**
 * Precise enough to be stable across runs — see packages/agent/src/prompts.ts
 * for the exact definitions given to the model. Severity/delivery impact
 * decide high_risk, not raw blocker count.
 */
export type AssessmentVerdict =
  "on_track" | "at_risk" | "high_risk" | "insufficient_evidence";

/**
 * Points at one already-collected Evidence item rather than duplicating
 * its content — "<Evidence.source>:<Evidence.id>", the same composite key
 * packages/agent/src/runner.ts's dedupeEvidence already uses to identify a
 * specific piece of evidence. Application-side validation (tools.ts)
 * rejects any reference that doesn't resolve to a real Evidence item; see
 * docs/decisions.md.
 */
export interface AssessmentSourceRef {
  evidenceId: string;
  /**
   * Explicit, not inferred from array position — a customer-facing
   * contract can't rely on ordering to imply authority.
   */
  role: "authoritative" | "corroborating" | "historical";
}

export interface AssessmentBlocker {
  title: string;
  explanation: string;
  sources: AssessmentSourceRef[];
}

/** Machine-readable project-risk verdict — see packages/agent/src/tools.ts's submit_assessment tool. */
export interface Assessment {
  verdict: AssessmentVerdict;
  summary: string;
  blockers: AssessmentBlocker[];
  uncertainty?: string[];
}

export interface InvestigationResult {
  answer: string;
  evidence: Evidence[];
  trace: ToolCallRecord[];
  /** Set only if the model proposed a write action this run — see packages/shared/src/approval.ts. */
  proposedAction?: ProposedAction;
  /** Set only for assessment-shaped questions (project delivery/risk/readiness) — see packages/agent/src/prompts.ts. */
  assessment?: Assessment;
}
