import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import {
  createLinearMcpClient,
  McpLinearIssueTracker,
} from "@agency-os/integration-linear-mcp-client";
import { GitHubPullRequestSource } from "@agency-os/integration-github";
import { SlackConversationSource } from "@agency-os/integration-slack";
import { LinearIssueWriter } from "@agency-os/integration-linear-writer";
import {
  loadProjectRegistry,
  type ProposedAction,
  type AuditRecord,
} from "@agency-os/shared";
import {
  investigate,
  reviewAndExecute,
  type AgentDependencies,
} from "@agency-os/agent";

// Resolve the repo-root .env by file location, not cwd: pnpm --filter runs
// this script with cwd set to apps/cli, so dotenv's default cwd-relative
// lookup silently misses the root .env.
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
config({ path: path.join(repoRoot, ".env") });

const PRIORITY_VALUE_TO_LABEL: Record<number, string> = {
  0: "None",
  1: "Urgent",
  2: "High",
  3: "Medium",
  4: "Low",
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(
      `Missing required environment variable: ${name}. See .env.example.`,
    );
    process.exit(1);
  }
  return value;
}

function printProposedAction(action: ProposedAction): void {
  console.log("\n=== Proposed action — nothing has been written yet ===");
  console.log(`Kind: ${action.kind}`);
  console.log(`Title: ${action.args.title}`);
  console.log(`Description:\n${action.args.description}`);
  console.log(
    `Priority: ${PRIORITY_VALUE_TO_LABEL[action.args.priority] ?? action.args.priority}`,
  );
  console.log(`Linear team: ${action.args.teamId}`);
  console.log(`Linear project: ${action.args.projectId}`);
  console.log(`Rationale: ${action.rationale}`);
  console.log(`Proposal ID: ${action.id}`);
  console.log(`Approval digest: ${action.approvalDigest}`);
}

async function promptForApproval(action: ProposedAction): Promise<boolean> {
  printProposedAction(action);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question("\nApprove this action? [y/N]: ");
    return answer.trim().toLowerCase() === "y";
  } finally {
    rl.close();
  }
}

function printAuditRecord(record: AuditRecord): void {
  console.log("\n=== Audit record ===");
  console.log(`Proposal: ${record.proposalId}`);
  console.log(`Decision: ${record.decision} (at ${record.decidedAt})`);
  if (!record.execution) {
    console.log("Execution: none — no write was attempted.");
    return;
  }
  console.log(`Execution outcome: ${record.execution.outcome}`);
  if (record.execution.error) {
    console.log(`Execution error: ${record.execution.error}`);
  }
  if (record.execution.createdIssue) {
    const issue = record.execution.createdIssue;
    console.log(`Created issue: ${issue.identifier} — ${issue.title}`);
    console.log(`URL: ${issue.url}`);
  }
}

async function main(): Promise<void> {
  // pnpm's arg-forwarding (`pnpm ask "..."` -> `pnpm --filter ... start -- "..."`)
  // inserts a literal "--" into argv; strip it rather than relying on
  // invocation details.
  const question = process.argv
    .slice(2)
    .filter((arg) => arg !== "--")
    .join(" ")
    .trim();
  if (!question) {
    console.error('Usage: pnpm ask "What is blocking Project Acme?"');
    process.exit(1);
  }

  const anthropicApiKey = requireEnv("ANTHROPIC_API_KEY");
  const linearApiKey = requireEnv("LINEAR_API_KEY");
  const githubToken = requireEnv("GITHUB_TOKEN");
  const slackBotToken = requireEnv("SLACK_BOT_TOKEN");
  // Separate, narrowly-scoped ("Create issues") write credential — never
  // the same key as LINEAR_API_KEY, and never passed to packages/agent or
  // the MCP subprocess. See docs/decisions.md for why this separation is
  // the actual safety boundary, not a runtime check.
  const linearApiKeyWrite = requireEnv("LINEAR_API_KEY_WRITE");

  // Linear reads are reached through the custom MCP server (mcp/linear),
  // spawned as a child process over stdio; GitHub and Slack stay in-process
  // (see docs/decisions.md for why this is deliberate incremental adoption,
  // not inconsistency). client.close() below terminates that child process.
  const linearMcpClient = await createLinearMcpClient({ linearApiKey });

  try {
    const issueTracker = new McpLinearIssueTracker(linearMcpClient);
    const deps: AgentDependencies = {
      issueTracker,
      pullRequestSource: new GitHubPullRequestSource(githubToken),
      slackMessageSource: new SlackConversationSource(slackBotToken),
      projectRegistry: loadProjectRegistry(),
    };

    console.error(`Investigating: ${question}\n`);

    const result = await investigate(question, deps, {
      anthropicApiKey,
      onEvent: (event) => {
        if (event.type === "tool_call") {
          const { tool, ok, durationMs, error } = event.detail as {
            tool: string;
            ok: boolean;
            durationMs: number;
            error?: string;
          };
          console.error(
            `  [tool] ${tool} ${ok ? "ok" : "FAILED"} (${durationMs}ms)${error ? ` — ${error}` : ""}`,
          );
        }
      },
    });

    console.log(`\n${result.answer}\n`);
    console.log(`Evidence (${result.evidence.length}):`);
    for (const item of result.evidence) {
      console.log(
        `  - [${item.source}] ${item.id}: ${item.summary}${item.url ? ` (${item.url})` : ""}`,
      );
    }

    if (result.proposedAction) {
      // reviewAndExecute is the only place in this process that touches a
      // write-capable Linear client — constructed here, used here, never
      // passed to anything the model's tool loop can reach.
      const record = await reviewAndExecute(result.proposedAction, {
        promptForApproval,
        issueWriter: new LinearIssueWriter(linearApiKeyWrite),
        issueTracker,
      });
      printAuditRecord(record);
    }
  } finally {
    await linearMcpClient.close();
  }
}

main().catch((err: unknown) => {
  console.error(
    "Investigation failed:",
    err instanceof Error ? err.message : err,
  );
  process.exit(1);
});
