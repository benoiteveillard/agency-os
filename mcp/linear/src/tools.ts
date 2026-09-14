import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { IssueTracker } from "@agency-os/integration-linear";

/**
 * Registers this server's two business-shaped tools against the given
 * IssueTracker. Depends on the interface, not LinearIssueTracker directly,
 * so the transport layer stays testable with a fake tracker and so a future
 * IssueTracker implementation change never touches this file.
 */
export function registerLinearTools(
  server: McpServer,
  issueTracker: IssueTracker,
): void {
  server.registerTool(
    "linear_list_project_issues",
    {
      description:
        "List every issue in a Linear project: status, priority, due date, an overdue flag, and explicit blocks/blockedBy relations to other issues. Returns structured Linear domain data, not a summarized answer.",
      inputSchema: {
        projectId: z.string().describe("Linear project UUID."),
      },
    },
    async ({ projectId }) => {
      try {
        const result = await issueTracker.listProjectIssues(projectId);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: (err as Error).message }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "linear_get_issue",
    {
      description:
        'Get a single Linear issue by UUID or human-readable identifier (e.g. "JUS-24"), including its explicit blocks/blockedBy relations. Returns structured Linear domain data, not a summarized answer.',
      inputSchema: {
        issueId: z
          .string()
          .describe('Linear issue UUID or identifier, e.g. "JUS-24".'),
      },
    },
    async ({ issueId }) => {
      try {
        const issue = await issueTracker.getIssue(issueId);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(issue) }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: (err as Error).message }],
          isError: true,
        };
      }
    },
  );
}
