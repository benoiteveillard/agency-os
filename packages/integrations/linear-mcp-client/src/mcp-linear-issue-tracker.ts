import type {
  IssueTracker,
  ProjectIssue,
  ProjectIssuesResult,
} from "@agency-os/integration-linear";

/**
 * The MCP client method this adapter actually needs, typed narrowly rather
 * than as the concrete SDK `Client` class so a hand-built fake can stand in
 * for tests without a real connection (mirrors the IssueLike/RelationLike
 * narrowing in @agency-os/integration-linear).
 *
 * Return type is `unknown`, not the SDK's real `CallToolResult` union:
 * that union also covers an experimental task-polling result shape with no
 * `content` field at all, which TypeScript's weak-type check rejects when
 * narrowed to an all-optional `{content?, isError?}` shape. `callJsonTool`
 * below validates the actual shape it needs at runtime instead — this
 * adapter doesn't support task-based tool execution, so anything without a
 * usable `content` text block is correctly treated as a failure either way.
 */
export interface McpToolCaller {
  callTool(params: {
    name: string;
    arguments?: Record<string, unknown>;
  }): Promise<unknown>;
}

interface RawToolResult {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

function isRawToolResult(value: unknown): value is RawToolResult {
  return typeof value === "object" && value !== null;
}

/**
 * IssueTracker implementation that reaches Linear through the custom MCP
 * server in mcp/linear instead of calling @linear/sdk directly. The agent
 * (packages/agent) never sees this — it only depends on IssueTracker.
 *
 * Error handling mirrors LinearIssueTracker's contract exactly: an MCP
 * `isError` result becomes a thrown Error, which packages/agent/src/runner.ts
 * already catches and surfaces to Claude as a failed tool call. No new
 * failure semantics are introduced by moving Linear behind MCP.
 */
export class McpLinearIssueTracker implements IssueTracker {
  constructor(private readonly client: McpToolCaller) {}

  async listProjectIssues(projectId: string): Promise<ProjectIssuesResult> {
    return this.callJsonTool<ProjectIssuesResult>(
      "linear_list_project_issues",
      { projectId },
    );
  }

  async getIssue(idOrIdentifier: string): Promise<ProjectIssue> {
    return this.callJsonTool<ProjectIssue>("linear_get_issue", {
      issueId: idOrIdentifier,
    });
  }

  private async callJsonTool<T>(
    name: string,
    args: Record<string, unknown>,
  ): Promise<T> {
    const raw = await this.client.callTool({ name, arguments: args });
    if (!isRawToolResult(raw)) {
      throw new Error(
        `Linear MCP tool "${name}" returned an unrecognized result shape`,
      );
    }

    const textBlock = raw.content?.find((block) => block.type === "text");
    const text = textBlock?.text ?? "";

    if (raw.isError) {
      throw new Error(
        `Linear MCP tool "${name}" failed: ${text || "no error detail returned"}`,
      );
    }
    if (!text) {
      throw new Error(`Linear MCP tool "${name}" returned no content`);
    }
    return JSON.parse(text) as T;
  }
}
