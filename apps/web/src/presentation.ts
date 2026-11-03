import { truncate, type SpanRecord } from "@agency-os/observability";
import type {
  Assessment,
  AuditRecord,
  InvestigationResult,
  ProposedAction,
} from "@agency-os/shared";

/** Only provider-owned HTTPS links; credentials, query strings and fragments are omitted. */
export function sourceUrl(
  value: string | undefined,
  source: "linear" | "github" | "slack",
): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    const allowed =
      source === "linear"
        ? url.hostname === "linear.app"
        : source === "github"
          ? url.hostname === "github.com"
          : url.hostname === "slack.com" || url.hostname.endsWith(".slack.com");
    if (
      !allowed ||
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port
    )
      return undefined;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

const MAX_EXCERPT_LENGTH = 280;

export function presentProposal(action: ProposedAction, expiresAt: string) {
  return {
    proposalId: action.id,
    kind: action.kind,
    title: action.args.title,
    description: action.args.description,
    priority: action.args.priority,
    // Target identifiers are presentation-only, never accepted on the decide endpoint.
    teamId: action.args.teamId,
    projectId: action.args.projectId,
    projectName: action.targetProjectName,
    rationale: action.rationale,
    evidenceIds: [...action.evidenceIds],
    expiresAt,
  };
}
export type ProposalPresentation = ReturnType<typeof presentProposal>;

function presentAssessment(value: Assessment): Assessment {
  return {
    verdict: value.verdict,
    summary: value.summary,
    blockers: value.blockers.map((blocker) => ({
      title: blocker.title,
      explanation: blocker.explanation,
      sources: blocker.sources.map((ref) => ({
        evidenceId: ref.evidenceId,
        role: ref.role,
      })),
    })),
    ...(value.uncertainty ? { uncertainty: [...value.uncertainty] } : {}),
  };
}
export function presentResult(
  result: InvestigationResult,
  traceId: string,
  durationMs: number,
  spans: readonly SpanRecord[],
  proposedActionPresentation?: ProposalPresentation,
) {
  // Only what the conclusion actually rests on gets an excerpt: enough for a
  // reader to check a citation without opening the source, and no more of the
  // retrieved data than that. It's untrusted text, rendered as plain text.
  const cited = new Set([
    ...(result.assessment?.blockers.flatMap((blocker) =>
      blocker.sources.map((ref) => ref.evidenceId),
    ) ?? []),
    ...(result.proposedAction?.evidenceIds ?? []),
  ]);
  const evidence = result.evidence.map((item) => ({
    evidenceId: `${item.source}:${item.id}`,
    source: item.source,
    id: item.id,
    ...(cited.has(`${item.source}:${item.id}`)
      ? { excerpt: truncate(item.summary, MAX_EXCERPT_LENGTH) }
      : {}),
    ...(item.timestamp ? { timestamp: item.timestamp } : {}),
    ...(sourceUrl(item.url, item.source)
      ? { url: sourceUrl(item.url, item.source) }
      : {}),
  }));
  const ids = new Set(evidence.map((item) => item.evidenceId));
  const assessment = result.assessment
    ? presentAssessment(result.assessment)
    : undefined;
  if (
    assessment?.blockers.some((blocker) =>
      blocker.sources.some((ref) => !ids.has(ref.evidenceId)),
    )
  ) {
    throw new Error("Assessment evidence reference does not resolve");
  }
  const tokens: { inputTokens?: number; outputTokens?: number } = {};
  for (const span of spans) {
    if (span.category !== "model" || span.name !== "model.turn") continue;
    for (const key of ["inputTokens", "outputTokens"] as const) {
      const value = span.attributes[key];
      if (
        typeof value === "number" &&
        Number.isSafeInteger(value) &&
        value >= 0
      ) {
        tokens[key] = (tokens[key] ?? 0) + value;
      }
    }
  }
  return {
    answer: result.answer,
    ...(assessment ? { assessment } : {}),
    evidence,
    ...(proposedActionPresentation ? { proposedActionPresentation } : {}),
    metadata: {
      traceId,
      durationMs: Math.max(0, durationMs),
      toolCallCount: result.trace.length,
      ...tokens,
    },
  };
}

export function presentAudit(audit: AuditRecord) {
  return {
    proposalId: audit.proposalId,
    decision: audit.decision,
    decidedAt: audit.decidedAt,
    ...(audit.execution
      ? {
          execution: {
            outcome: audit.execution.outcome,
            ...(audit.execution.outcome === "failure"
              ? {
                  error: {
                    code: "execution_failed",
                    message:
                      "Execution failed. This proposal will not be retried.",
                  },
                }
              : {}),
            ...(audit.execution.createdIssue
              ? {
                  createdIssue: {
                    identifier: audit.execution.createdIssue.identifier,
                    title: audit.execution.createdIssue.title,
                    url: sourceUrl(audit.execution.createdIssue.url, "linear"),
                  },
                }
              : {}),
          },
        }
      : {}),
  };
}
