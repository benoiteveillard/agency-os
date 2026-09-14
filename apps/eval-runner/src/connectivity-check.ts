import Anthropic from "@anthropic-ai/sdk";
import { GitHubPullRequestSource } from "@agency-os/integration-github";
import { SlackConversationSource } from "@agency-os/integration-slack";
import {
  createLinearMcpClient,
  McpLinearIssueTracker,
} from "@agency-os/integration-linear-mcp-client";
import { loadProjectRegistry } from "@agency-os/shared";

export interface ConnectivityCheckResult {
  ok: boolean;
  error?: string;
}

export interface ConnectivityReport {
  anthropic: ConnectivityCheckResult;
  linear: ConnectivityCheckResult;
  github: ConnectivityCheckResult;
  slack: ConnectivityCheckResult;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

/**
 * Four fully independent checks (Promise.all, no shared setup beyond each
 * check's own try/catch) — so one unavailable provider (e.g. Anthropic out
 * of credits) can never make an unrelated integration appear to have
 * failed. Uses the narrowest existing read operation per integration; adds
 * no new production capability. See docs/evaluation.md.
 */
export async function runConnectivityCheck(): Promise<ConnectivityReport> {
  const [anthropic, linear, github, slack] = await Promise.all([
    checkAnthropic(),
    checkLinear(),
    checkGithub(),
    checkSlack(),
  ]);
  return { anthropic, linear, github, slack };
}

async function checkAnthropic(): Promise<ConnectivityCheckResult> {
  try {
    const client = new Anthropic({ apiKey: requireEnv("ANTHROPIC_API_KEY") });
    await client.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 5,
      thinking: { type: "disabled" },
      messages: [{ role: "user", content: "ping" }],
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message.slice(0, 200) };
  }
}

async function checkLinear(): Promise<ConnectivityCheckResult> {
  let client: Awaited<ReturnType<typeof createLinearMcpClient>> | undefined;
  try {
    client = await createLinearMcpClient({
      linearApiKey: requireEnv("LINEAR_API_KEY"),
    });
    const tracker = new McpLinearIssueTracker(client);
    const entry = loadProjectRegistry()["acme-website-migration"];
    if (!entry)
      throw new Error("acme-website-migration missing from project registry");
    await tracker.listProjectIssues(entry.linearProjectId);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message.slice(0, 200) };
  } finally {
    if (client) await client.close();
  }
}

async function checkGithub(): Promise<ConnectivityCheckResult> {
  try {
    const source = new GitHubPullRequestSource(requireEnv("GITHUB_TOKEN"));
    const entry = loadProjectRegistry()["acme-website-migration"];
    if (!entry)
      throw new Error("acme-website-migration missing from project registry");
    await source.listPullRequests(entry.githubOwner, entry.githubRepo);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message.slice(0, 200) };
  }
}

async function checkSlack(): Promise<ConnectivityCheckResult> {
  try {
    const source = new SlackConversationSource(requireEnv("SLACK_BOT_TOKEN"));
    const entry = loadProjectRegistry()["acme-website-migration"];
    if (!entry)
      throw new Error("acme-website-migration missing from project registry");
    await source.getChannelMessages(entry.slackChannelId);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message.slice(0, 200) };
  }
}
