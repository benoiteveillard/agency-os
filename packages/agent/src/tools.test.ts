import { describe, expect, it } from "vitest";
import type {
  IssueTracker,
  ProjectIssuesResult,
} from "@agency-os/integration-linear";
import type {
  PullRequestSource,
  PullRequestSummary,
} from "@agency-os/integration-github";
import type { WorkflowRunStatusSummary } from "@agency-os/integration-github";
import { executeTool, type AgentDependencies } from "./tools.js";

const fakeProjectIssues: ProjectIssuesResult = {
  project: {
    id: "proj_1",
    name: "Acme Website Migration",
    url: "https://linear.app/acme/project/1",
    targetDate: "2026-09-18",
    health: "atRisk",
  },
  issues: [
    {
      id: "issue_1",
      identifier: "ACM-12",
      title: "CMS migration blocked on data export",
      url: "https://linear.app/acme/issue/ACM-12",
      state: "Blocked",
      stateType: "started",
      priorityLabel: "Urgent",
      dueDate: "2026-09-10",
      overdue: true,
      updatedAt: "2026-09-11T00:00:00.000Z",
      blockedBy: [
        { id: "issue_2", identifier: "ACM-9", title: "Export tool broken" },
      ],
      blocks: [
        { id: "issue_3", identifier: "ACM-20", title: "Launch checklist" },
      ],
    },
  ],
};

function makeDeps(
  overrides: Partial<AgentDependencies> = {},
): AgentDependencies {
  const issueTracker: IssueTracker = {
    listProjectIssues: async () => fakeProjectIssues,
    getIssue: async () => fakeProjectIssues.issues[0]!,
  };
  const pullRequestSource: PullRequestSource = {
    listPullRequests: async (): Promise<PullRequestSummary[]> => [
      {
        number: 142,
        title: "Checkout redesign",
        url: "https://github.com/os-agency-fake/acme-website-migration/pull/142",
        draft: false,
        headSha: "abc1234def",
        baseBranch: "main",
        updatedAt: "2026-09-11T00:00:00.000Z",
        requestedReviewers: ["sarah"],
        reviews: [],
      },
    ],
    getWorkflowRunStatus: async (): Promise<WorkflowRunStatusSummary> => ({
      status: "failing",
      runs: [
        {
          workflowName: "CI",
          status: "completed",
          conclusion: "failure",
          url: "https://github.com/os-agency-fake/acme-website-migration/actions/runs/1",
        },
      ],
    }),
  };

  return {
    issueTracker,
    pullRequestSource,
    projectRegistry: {
      "acme-website-migration": {
        displayName: "Acme Website Migration",
        linearProjectId: "proj_1",
        githubOwner: "os-agency-fake",
        githubRepo: "acme-website-migration",
      },
    },
    ...overrides,
  };
}

describe("executeTool", () => {
  it("returns issues with blocking evidence for linear_list_project_issues", async () => {
    const result = await executeTool(
      "linear_list_project_issues",
      { projectSlug: "acme-website-migration" },
      makeDeps(),
    );

    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]).toMatchObject({
      source: "linear",
      id: "ACM-12",
    });
    expect(result.evidence[0]?.summary).toContain("OVERDUE");
    expect(result.evidence[0]?.summary).toContain("blocked by ACM-9");
    expect(result.evidence[0]?.summary).toContain("blocks ACM-20");
  });

  it("returns PR evidence for github_list_pull_requests", async () => {
    const result = await executeTool(
      "github_list_pull_requests",
      { projectSlug: "acme-website-migration" },
      makeDeps(),
    );

    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]?.summary).toContain("PR #142");
  });

  it("returns workflow-run evidence for github_get_workflow_run_status", async () => {
    const result = await executeTool(
      "github_get_workflow_run_status",
      { projectSlug: "acme-website-migration", ref: "abc1234def" },
      makeDeps(),
    );

    expect(result.evidence[0]?.summary).toContain("failing");
    expect(result.evidence[0]?.summary).toContain("CI=failure");
  });

  it("reports unknown, not a guess, when no workflow run exists for the SHA", async () => {
    const deps = makeDeps({
      pullRequestSource: {
        listPullRequests: async () => [],
        getWorkflowRunStatus: async (): Promise<WorkflowRunStatusSummary> => ({
          status: "unknown",
          runs: [],
        }),
      },
    });

    const result = await executeTool(
      "github_get_workflow_run_status",
      { projectSlug: "acme-website-migration", ref: "deadbeef" },
      deps,
    );

    expect(result.evidence[0]?.summary).toContain("unknown");
    expect(result.evidence[0]?.summary).toContain("no workflow run found");
  });

  it("rejects an unknown project slug instead of guessing", async () => {
    await expect(
      executeTool(
        "linear_list_project_issues",
        { projectSlug: "does-not-exist" },
        makeDeps(),
      ),
    ).rejects.toThrow(/Unknown project slug/);
  });

  it("rejects a missing required field instead of calling the integration with undefined", async () => {
    await expect(
      executeTool("linear_list_project_issues", {}, makeDeps()),
    ).rejects.toThrow(/missing required string field "projectSlug"/);
  });

  it("rejects an unknown tool name", async () => {
    await expect(
      executeTool("linear_delete_everything", {}, makeDeps()),
    ).rejects.toThrow(/Unknown tool/);
  });
});
