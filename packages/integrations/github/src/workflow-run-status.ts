export type WorkflowRunOverallStatus =
  "success" | "failing" | "pending" | "unknown";

/**
 * GitHub's conclusion value for a completed workflow run — one of "success",
 * "failure", "neutral", "cancelled", "skipped", "timed_out",
 * "action_required", "stale", or `null` while the run hasn't completed yet
 * (still queued/in_progress). Typed as `string | null` rather than a strict
 * union because Octokit's own generated types don't narrow it further.
 */
export type WorkflowRunConclusion = string | null;

export interface WorkflowRunInput {
  workflowName: string;
  status: string;
  conclusion: WorkflowRunConclusion;
  url: string;
  /** When the run last changed. Absent only in older fixtures. */
  updatedAt?: string;
}

export interface WorkflowRunDetail {
  workflowName: string;
  status: string;
  conclusion: WorkflowRunConclusion;
  url: string;
  /** When the run last changed. Absent only in older fixtures. */
  updatedAt?: string;
}

export interface WorkflowRunStatusSummary {
  status: WorkflowRunOverallStatus;
  runs: WorkflowRunDetail[];
  /** Set when more runs exist for this commit than were fetched. */
  truncated?: boolean;
}

const FAILING_CONCLUSIONS = new Set([
  "failure",
  "timed_out",
  "action_required",
  "cancelled",
  "startup_failure",
]);

/** Completed without failing, but say nothing about the commit being good. */
const INCONCLUSIVE_CONCLUSIONS = new Set(["neutral", "skipped"]);

/**
 * Reduces a commit's GitHub Actions workflow runs into one status Claude can
 * reason about directly, while keeping per-run detail for citation. Backed
 * by the Actions API (`GET /repos/{owner}/{repo}/actions/runs?head_sha=`),
 * not the Checks API — fine-grained PATs cannot be granted Checks
 * permissions (see docs/decisions.md). Pulled out as a pure function so
 * it's testable without a live GitHub call.
 */
export function summarizeWorkflowRuns(
  runs: WorkflowRunInput[],
): WorkflowRunStatusSummary {
  if (runs.length === 0) {
    return { status: "unknown", runs: [] };
  }

  const failing = runs.filter(
    (run) => run.conclusion !== null && FAILING_CONCLUSIONS.has(run.conclusion),
  );
  const pending = runs.filter((run) => run.status !== "completed");

  const succeeded = runs.some((run) => run.conclusion === "success");
  // A conclusion this code doesn't recognize (stale, or one GitHub adds later)
  // stays unknown: CI is an authoritative source, so it must not read as green
  // by default.
  const unrecognized = runs.some(
    (run) =>
      run.status === "completed" &&
      run.conclusion !== "success" &&
      !INCONCLUSIVE_CONCLUSIONS.has(run.conclusion ?? ""),
  );

  let status: WorkflowRunOverallStatus;
  if (failing.length > 0) status = "failing";
  else if (pending.length > 0) status = "pending";
  else if (succeeded && !unrecognized) status = "success";
  else status = "unknown";

  return {
    status,
    runs: runs.map((run) => ({
      workflowName: run.workflowName,
      status: run.status,
      conclusion: run.conclusion,
      url: run.url,
      ...(run.updatedAt ? { updatedAt: run.updatedAt } : {}),
    })),
  };
}
