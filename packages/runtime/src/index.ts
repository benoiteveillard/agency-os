import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { AgentDependencies } from "@agency-os/agent";
import { GitHubPullRequestSource } from "@agency-os/integration-github";
import {
  createLinearMcpClient,
  McpLinearIssueTracker,
} from "@agency-os/integration-linear-mcp-client";
import { LinearIssueWriter } from "@agency-os/integration-linear-writer";
import { SlackConversationSource } from "@agency-os/integration-slack";
import {
  loadProjectRegistry,
  type AuditLog,
  type IssueWriter,
} from "@agency-os/shared";

export interface ProductionRuntime {
  dependencies: AgentDependencies;
  anthropicApiKey: string;
  /** Approval code only: never included in the model's read dependencies. */
  issueWriter: IssueWriter;
  close(): Promise<void>;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}. See .env.example.`,
    );
  }
  return value;
}

/**
 * Append-only JSONL. Holds proposal text, so it's readable by the owner only.
 * A rejected append rejects the caller: see the approval flow, which refuses to
 * execute a decision it couldn't record.
 */
export function createFileAuditLog(filePath: string): AuditLog {
  return {
    append: async (entry) => {
      await mkdir(path.dirname(filePath), { recursive: true });
      await appendFile(filePath, `${JSON.stringify(entry)}\n`, {
        encoding: "utf-8",
        mode: 0o600,
      });
    },
  };
}

export interface ProductionRuntimeOptions {
  /**
   * Defaults to true. When false the write credential isn't read at all, so a
   * deployment that never writes doesn't have to hold one, and the returned
   * issueWriter refuses every call.
   */
  writesEnabled?: boolean;
}

const REFUSING_ISSUE_WRITER: IssueWriter = {
  createIssue: async () => {
    throw new Error("Writes are disabled for this runtime.");
  },
};

/**
 * Shared production wiring for application adapters. Apps own dotenv loading,
 * tracing and lifecycle; the factory owns one connected Linear MCP process.
 * Its transport forwards only the read credential to the child process.
 */
export async function createProductionRuntime(
  options: ProductionRuntimeOptions = {},
): Promise<ProductionRuntime> {
  const anthropicApiKey = requireEnv("ANTHROPIC_API_KEY");
  const linearApiKey = requireEnv("LINEAR_API_KEY");
  const githubToken = requireEnv("GITHUB_TOKEN");
  const slackBotToken = requireEnv("SLACK_BOT_TOKEN");
  const linearApiKeyWrite =
    options.writesEnabled === false
      ? undefined
      : requireEnv("LINEAR_API_KEY_WRITE");
  const projectRegistry = loadProjectRegistry();
  const client = await createLinearMcpClient({ linearApiKey });
  try {
    const dependencies: AgentDependencies = {
      issueTracker: new McpLinearIssueTracker(client),
      pullRequestSource: new GitHubPullRequestSource(githubToken),
      slackMessageSource: new SlackConversationSource(slackBotToken),
      projectRegistry,
    };
    const issueWriter = linearApiKeyWrite
      ? new LinearIssueWriter(linearApiKeyWrite)
      : REFUSING_ISSUE_WRITER;
    let closing: Promise<void> | undefined;
    return {
      dependencies,
      anthropicApiKey,
      issueWriter,
      close: () => (closing ??= client.close()),
    };
  } catch (error) {
    // Preserve the construction failure even if teardown also fails.
    await client.close().catch(() => {});
    throw error;
  }
}
