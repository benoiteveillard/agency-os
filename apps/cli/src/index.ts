import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { LinearIssueTracker } from "@agency-os/integration-linear";
import { GitHubPullRequestSource } from "@agency-os/integration-github";
import { loadProjectRegistry } from "@agency-os/shared";
import { investigate, type AgentDependencies } from "@agency-os/agent";

// Resolve the repo-root .env by file location, not cwd: pnpm --filter runs
// this script with cwd set to apps/cli, so dotenv's default cwd-relative
// lookup silently misses the root .env.
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
config({ path: path.join(repoRoot, ".env") });

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

  const deps: AgentDependencies = {
    issueTracker: new LinearIssueTracker(linearApiKey),
    pullRequestSource: new GitHubPullRequestSource(githubToken),
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
}

main().catch((err: unknown) => {
  console.error(
    "Investigation failed:",
    err instanceof Error ? err.message : err,
  );
  process.exit(1);
});
