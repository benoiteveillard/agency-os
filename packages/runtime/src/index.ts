import type { AgentDependencies } from "@agency-os/agent";
import { GitHubPullRequestSource } from "@agency-os/integration-github";
import {
  createLinearMcpClient,
  McpLinearIssueTracker,
} from "@agency-os/integration-linear-mcp-client";
import { LinearIssueWriter } from "@agency-os/integration-linear-writer";
import { SlackConversationSource } from "@agency-os/integration-slack";
import { loadProjectRegistry, type IssueWriter } from "@agency-os/shared";

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
 * Shared production wiring for application adapters. Apps own dotenv loading,
 * tracing and lifecycle; the factory owns one connected Linear MCP process.
 * Its transport forwards only the read credential to the child process.
 */
export async function createProductionRuntime(): Promise<ProductionRuntime> {
  const anthropicApiKey = requireEnv("ANTHROPIC_API_KEY");
  const linearApiKey = requireEnv("LINEAR_API_KEY");
  const githubToken = requireEnv("GITHUB_TOKEN");
  const slackBotToken = requireEnv("SLACK_BOT_TOKEN");
  const linearApiKeyWrite = requireEnv("LINEAR_API_KEY_WRITE");
  const projectRegistry = loadProjectRegistry();
  const client = await createLinearMcpClient({ linearApiKey });
  try {
    const dependencies: AgentDependencies = {
      issueTracker: new McpLinearIssueTracker(client),
      pullRequestSource: new GitHubPullRequestSource(githubToken),
      slackMessageSource: new SlackConversationSource(slackBotToken),
      projectRegistry,
    };
    const issueWriter = new LinearIssueWriter(linearApiKeyWrite);
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
