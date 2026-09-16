// Mirrors the wire shapes actually produced by apps/web/src/presentation.ts —
// not @agency-os/shared's domain types, which presentation.ts transforms
// before anything reaches the browser (e.g. Evidence gains a composite
// evidenceId; ProposedAction is flattened and loses id/approvalDigest/args).
// Only the primitive unions (verdict, source role) are identical either way.

export type Source = "linear" | "github" | "slack";
export type AssessmentVerdict =
  "on_track" | "at_risk" | "high_risk" | "insufficient_evidence";
export type SourceRole = "authoritative" | "corroborating" | "historical";

export interface Evidence {
  evidenceId: string;
  source: Source;
  id: string;
  timestamp?: string;
  url?: string;
}

export interface AssessmentSourceRef {
  evidenceId: string;
  role: SourceRole;
}

export interface AssessmentBlocker {
  title: string;
  explanation: string;
  sources: AssessmentSourceRef[];
}

export interface Assessment {
  verdict: AssessmentVerdict;
  summary: string;
  blockers: AssessmentBlocker[];
  uncertainty?: string[];
}

export interface ProposalPresentation {
  proposalId: string;
  kind: "linear_create_issue";
  title: string;
  description: string;
  priority: number;
  teamId: string;
  projectId: string;
  rationale: string;
  expiresAt: string;
}

export interface InvestigationMetadata {
  traceId: string;
  durationMs: number;
  toolCallCount: number;
  inputTokens?: number;
  outputTokens?: number;
}

export interface InvestigationResultDTO {
  answer: string;
  assessment?: Assessment;
  evidence: Evidence[];
  proposedActionPresentation?: ProposalPresentation;
  metadata: InvestigationMetadata;
}

export interface ApiError {
  code: string;
  message: string;
}

export interface CreatedIssueSummary {
  identifier: string;
  title: string;
  url?: string;
}

export interface AuditDTO {
  proposalId: string;
  decision: "approved" | "rejected";
  decidedAt: string;
  execution?: {
    outcome:
      "success" | "failure" | "executed_unconfirmed" | "execution_disabled";
    error?: ApiError;
    createdIssue?: CreatedIssueSummary;
  };
}

// --- SSE event payloads (apps/web/src/app.ts / progress.ts) ---------------

export interface InvestigationStartedData {
  traceId: string;
}
export interface SourceActivityData {
  activityId: number;
  source: Source;
  ok?: boolean;
}
export interface AssessmentActivityData {
  activityId: number;
  ok?: boolean;
}
export interface AssessmentReadyData {
  verdict: AssessmentVerdict;
  blockerCount: number;
}
export interface InvestigationFailedData {
  error: ApiError;
  traceId?: string;
}

export type SSEMessage =
  | { event: "investigation.started"; data: InvestigationStartedData }
  | { event: "source.started"; data: SourceActivityData }
  | { event: "source.completed"; data: SourceActivityData }
  | { event: "assessment.started"; data: AssessmentActivityData }
  | { event: "assessment.completed"; data: AssessmentActivityData }
  | { event: "assessment.ready"; data: AssessmentReadyData }
  | { event: "action.proposed"; data: ProposalPresentation }
  | { event: "investigation.completed"; data: InvestigationResultDTO }
  | { event: "investigation.failed"; data: InvestigationFailedData };
