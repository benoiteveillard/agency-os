import {
  createLinearMcpClient,
  McpLinearIssueTracker,
} from "@agency-os/integration-linear-mcp-client";
import { GitHubPullRequestSource } from "@agency-os/integration-github";
import { SlackConversationSource } from "@agency-os/integration-slack";
import {
  loadProjectRegistry,
  type IssueWriter,
  type ProjectRegistryEntry,
} from "@agency-os/shared";
import type { IssueTracker } from "@agency-os/integration-linear";
import type { PullRequestSource } from "@agency-os/integration-github";
import type { SlackMessageSource } from "@agency-os/integration-slack";
import { FixtureIssueTracker } from "./fixtures/fixture-issue-tracker.js";
import { FixturePullRequestSource } from "./fixtures/fixture-pull-request-source.js";
import { FixtureSlackSource } from "./fixtures/fixture-slack-source.js";
import { FixtureIssueWriter } from "./fixtures/fixture-issue-writer.js";
import { RefusingIssueWriter } from "./fixtures/refusing-issue-writer.js";
import type { EvalRunnerConfig } from "./config.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export interface BuiltDependencies {
  issueTracker: IssueTracker;
  pullRequestSource: PullRequestSource;
  slackMessageSource: SlackMessageSource;
  issueWriter: IssueWriter;
  projectRegistry: Record<string, ProjectRegistryEntry>;
  /** Present only in live mode — must be closed by the caller. */
  closeLiveMcpClient?: () => Promise<void>;
}

/**
 * Builds the same dependency-injected interfaces apps/cli builds, so
 * investigate()/reviewAndExecute() run completely unmodified in both modes.
 * Live mode never wires a real write-capable client — writes are
 * structurally refused (RefusingIssueWriter) since the live suite is
 * read-only by design, independent of what any scenario configures.
 */
export async function buildDependencies(
  config: EvalRunnerConfig,
): Promise<BuiltDependencies> {
  if (config.mode === "live") {
    const linearApiKey = requireEnv("LINEAR_API_KEY");
    const githubToken = requireEnv("GITHUB_TOKEN");
    const slackBotToken = requireEnv("SLACK_BOT_TOKEN");

    const linearMcpClient = await createLinearMcpClient({ linearApiKey });

    return {
      issueTracker: new McpLinearIssueTracker(linearMcpClient),
      pullRequestSource: new GitHubPullRequestSource(githubToken),
      slackMessageSource: new SlackConversationSource(slackBotToken),
      issueWriter: new RefusingIssueWriter(),
      projectRegistry: loadProjectRegistry(),
      closeLiveMcpClient: () => linearMcpClient.close(),
    };
  }

  const fixtures = config.fixtures;
  if (!fixtures) {
    throw new Error('Config error: mode "fixture" requires "fixtures"');
  }

  return {
    issueTracker: new FixtureIssueTracker(
      fixtures.linear ?? {
        listProjectIssues: {
          ok: false,
          error:
            "Fixture misconfigured: no linear fixture configured for this scenario, but a Linear read was attempted",
        },
      },
    ),
    pullRequestSource: new FixturePullRequestSource(
      fixtures.github ?? {
        listPullRequests: {
          ok: false,
          error:
            "Fixture misconfigured: no github fixture configured for this scenario, but a GitHub read was attempted",
        },
        workflowRunStatusByRef: {},
      },
    ),
    slackMessageSource: new FixtureSlackSource(
      fixtures.slack ?? {
        channelMessages: {
          ok: false,
          error:
            "Fixture misconfigured: no slack fixture configured for this scenario, but a Slack read was attempted",
        },
        threadsByTs: {},
      },
    ),
    // Scenarios that don't expect a write get no issueWriter fixture at
    // all; if one is unexpectedly attempted anyway, fail loudly with a
    // scenario-authoring-shaped message rather than a live-mode one.
    issueWriter: fixtures.issueWriter
      ? new FixtureIssueWriter(fixtures.issueWriter)
      : new FixtureIssueWriter({
          createIssue: {
            ok: false,
            error:
              "Fixture misconfigured: no issueWriter fixture configured for this scenario, but createIssue was called",
          },
        }),
    projectRegistry: config.projectRegistry ?? {},
  };
}
