import type Anthropic from "@anthropic-ai/sdk";
import type { IssueTracker } from "@agency-os/integration-linear";
import type { PullRequestSource } from "@agency-os/integration-github";
import type { Evidence, ProjectRegistryEntry } from "@agency-os/shared";

export interface AgentDependencies {
  issueTracker: IssueTracker;
  pullRequestSource: PullRequestSource;
  projectRegistry: Record<string, ProjectRegistryEntry>;
}

export interface ToolExecutionResult {
  data: unknown;
  evidence: Evidence[];
}

/**
 * Tool names use underscores, not the dotted `linear.list_project_issues`
 * style from README.md #9 — Anthropic's tool-name field doesn't accept dots.
 * The dotted form remains the conceptual/business-capability name.
 */
export const TOOLS: Anthropic.Tool[] = [
  {
    name: "linear_list_project_issues",
    description:
      "List every issue in a Linear project: status, priority, due date, an overdue flag, and which other issues currently block each one. Use this to find open work, overdue tasks, and blockers.",
    input_schema: {
      type: "object",
      properties: {
        projectSlug: {
          type: "string",
          description:
            "Internal project slug from the known-projects list in the system prompt.",
        },
      },
      required: ["projectSlug"],
    },
  },
  {
    name: "github_list_pull_requests",
    description:
      "List open pull requests for a project's GitHub repository: draft status, requested reviewers, submitted reviews, and each PR's head commit SHA (needed for github_get_workflow_run_status).",
    input_schema: {
      type: "object",
      properties: {
        projectSlug: {
          type: "string",
          description:
            "Internal project slug from the known-projects list in the system prompt.",
        },
      },
      required: ["projectSlug"],
    },
  },
  {
    name: "github_get_workflow_run_status",
    description:
      "Get the GitHub Actions workflow run status (success, failing, or pending) for a specific commit SHA in a project's GitHub repository, including which workflow(s) ran and their conclusion. Call this with a pull request's headSha after listing pull requests. If no workflow run is found for that SHA, this reports status as unknown rather than assuming success or failure.",
    input_schema: {
      type: "object",
      properties: {
        projectSlug: {
          type: "string",
          description:
            "Internal project slug from the known-projects list in the system prompt.",
        },
        ref: {
          type: "string",
          description:
            "Commit SHA to check, typically a pull request's headSha.",
        },
      },
      required: ["projectSlug", "ref"],
    },
  },
];

function resolveProject(
  deps: AgentDependencies,
  projectSlug: string,
): ProjectRegistryEntry {
  const entry = deps.projectRegistry[projectSlug];
  if (!entry) {
    const known = Object.keys(deps.projectRegistry).join(", ");
    throw new Error(
      `Unknown project slug "${projectSlug}". Known slugs: ${known}`,
    );
  }
  return entry;
}

function requireString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Tool input missing required string field "${key}"`);
  }
  return value;
}

export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  deps: AgentDependencies,
): Promise<ToolExecutionResult> {
  switch (name) {
    case "linear_list_project_issues": {
      const project = resolveProject(deps, requireString(input, "projectSlug"));
      const result = await deps.issueTracker.listProjectIssues(
        project.linearProjectId,
      );

      const evidence: Evidence[] = result.issues.map((issue) => ({
        source: "linear",
        id: issue.identifier,
        url: issue.url,
        summary:
          `${issue.identifier} "${issue.title}" — state=${issue.state}, priority=${issue.priorityLabel}` +
          (issue.overdue ? ", OVERDUE" : "") +
          (issue.blockedBy.length > 0
            ? `, blocked by ${issue.blockedBy.map((b) => b.identifier).join(", ")}`
            : "") +
          (issue.blocks.length > 0
            ? `, blocks ${issue.blocks.map((b) => b.identifier).join(", ")}`
            : ""),
        timestamp: issue.updatedAt,
      }));

      return { data: result, evidence };
    }

    case "github_list_pull_requests": {
      const project = resolveProject(deps, requireString(input, "projectSlug"));
      const pulls = await deps.pullRequestSource.listPullRequests(
        project.githubOwner,
        project.githubRepo,
      );

      const evidence: Evidence[] = pulls.map((pr) => ({
        source: "github",
        id: `#${pr.number}`,
        url: pr.url,
        summary:
          `PR #${pr.number} "${pr.title}"${pr.draft ? " (draft)" : ""} — ` +
          `reviews: ${pr.reviews.map((r) => `${r.user}:${r.state}`).join(", ") || "none"}, ` +
          `requested reviewers: ${pr.requestedReviewers.join(", ") || "none"}`,
        timestamp: pr.updatedAt,
      }));

      return { data: pulls, evidence };
    }

    case "github_get_workflow_run_status": {
      const project = resolveProject(deps, requireString(input, "projectSlug"));
      const ref = requireString(input, "ref");
      const status = await deps.pullRequestSource.getWorkflowRunStatus(
        project.githubOwner,
        project.githubRepo,
        ref,
      );

      const runsDesc =
        status.runs.length > 0
          ? status.runs
              .map(
                (run) => `${run.workflowName}=${run.conclusion ?? run.status}`,
              )
              .join(", ")
          : "no workflow run found for this commit";

      const evidence: Evidence[] = [
        {
          source: "github",
          id: ref.slice(0, 7),
          summary: `Workflow run status for ${ref.slice(0, 7)}: ${status.status} (${runsDesc})`,
        },
      ];

      return { data: status, evidence };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
