import { Octokit } from "@octokit/rest";
import {
  summarizeWorkflowRuns,
  type WorkflowRunStatusSummary,
} from "./workflow-run-status.js";

export interface PullRequestReview {
  user: string;
  state: string;
}

export interface PullRequestSummary {
  number: number;
  title: string;
  url: string;
  draft: boolean;
  headSha: string;
  baseBranch: string;
  updatedAt: string;
  requestedReviewers: string[];
  reviews: PullRequestReview[];
}

/**
 * Read-only port for pull-request data. GitHubPullRequestSource is the only
 * implementation today (AGENTS.md #11).
 */
export interface PullRequestSource {
  listPullRequests(owner: string, repo: string): Promise<PullRequestSummary[]>;
  getWorkflowRunStatus(
    owner: string,
    repo: string,
    ref: string,
  ): Promise<WorkflowRunStatusSummary>;
}

export class GitHubPullRequestSource implements PullRequestSource {
  private readonly octokit: Octokit;

  constructor(token: string) {
    this.octokit = new Octokit({ auth: token });
  }

  async listPullRequests(
    owner: string,
    repo: string,
  ): Promise<PullRequestSummary[]> {
    try {
      const { data: pulls } = await this.octokit.rest.pulls.list({
        owner,
        repo,
        state: "open",
        per_page: 100,
      });

      return await Promise.all(
        pulls.map(async (pr) => {
          const { data: reviews } = await this.octokit.rest.pulls.listReviews({
            owner,
            repo,
            pull_number: pr.number,
            per_page: 100,
          });

          return {
            number: pr.number,
            title: pr.title,
            url: pr.html_url,
            draft: pr.draft ?? false,
            headSha: pr.head.sha,
            baseBranch: pr.base.ref,
            updatedAt: pr.updated_at,
            requestedReviewers: (pr.requested_reviewers ?? []).map(
              (reviewer) => reviewer.login,
            ),
            reviews: reviews.map((review) => ({
              user: review.user?.login ?? "unknown",
              state: review.state,
            })),
          };
        }),
      );
    } catch (err) {
      throw new Error(
        `GitHub: failed to list pull requests for ${owner}/${repo}: ${(err as Error).message}`,
        { cause: err },
      );
    }
  }

  /**
   * Backed by the Actions API, not the Checks API: fine-grained PATs cannot
   * be granted Checks permissions at all (verified live, see
   * docs/decisions.md), while "Actions: Read-only" works.
   */
  async getWorkflowRunStatus(
    owner: string,
    repo: string,
    ref: string,
  ): Promise<WorkflowRunStatusSummary> {
    try {
      const { data } = await this.octokit.rest.actions.listWorkflowRunsForRepo({
        owner,
        repo,
        head_sha: ref,
        per_page: 20,
      });

      return summarizeWorkflowRuns(
        data.workflow_runs.map((run) => ({
          workflowName: run.name ?? "unknown workflow",
          status: run.status ?? "unknown",
          conclusion: run.conclusion,
          url: run.html_url,
        })),
      );
    } catch (err) {
      throw new Error(
        `GitHub: failed to get workflow run status for ${owner}/${repo}@${ref}: ${(err as Error).message}`,
        { cause: err },
      );
    }
  }
}
