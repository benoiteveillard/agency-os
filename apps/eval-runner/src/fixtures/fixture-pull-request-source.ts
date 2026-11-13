import type {
  PullRequestList,
  PullRequestSource,
  PullRequestSummary,
  WorkflowRunStatusSummary,
} from "@agency-os/integration-github";
import type { FixtureOutcome } from "./types.js";

export interface GithubFixtureConfig {
  listPullRequests: FixtureOutcome<PullRequestSummary[]>;
  /** Keyed by the commit ref the scenario expects getWorkflowRunStatus to be called with. */
  workflowRunStatusByRef: Record<
    string,
    FixtureOutcome<WorkflowRunStatusSummary>
  >;
}

export class FixturePullRequestSource implements PullRequestSource {
  constructor(private readonly config: GithubFixtureConfig) {}

  async listPullRequests(
    _owner: string,
    _repo: string,
  ): Promise<PullRequestList> {
    const outcome = this.config.listPullRequests;
    if (!outcome.ok) throw new Error(outcome.error);
    return { pullRequests: outcome.value, truncated: false };
  }

  async getWorkflowRunStatus(
    _owner: string,
    _repo: string,
    ref: string,
  ): Promise<WorkflowRunStatusSummary> {
    const outcome = this.config.workflowRunStatusByRef[ref];
    if (!outcome) {
      throw new Error(
        `Fixture misconfigured: no workflowRunStatusByRef entry for ref "${ref}"`,
      );
    }
    if (!outcome.ok) throw new Error(outcome.error);
    return outcome.value;
  }
}
