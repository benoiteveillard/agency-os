import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { createProductionRuntime } from "@agency-os/runtime";
import { type ProposedAction, type AuditRecord } from "@agency-os/shared";
import { investigate, reviewAndExecute } from "@agency-os/agent";
import {
  Tracer,
  formatTraceTree,
  serializeTraceFile,
  type RunSummary,
} from "@agency-os/observability";
import { exportTrace } from "@agency-os/observability-otel-export";

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

  const runtime = await createProductionRuntime();

  // Owns the whole CLI lifecycle's trace — investigation, approval, and
  // execution are one coherent tree under this single root span, not three
  // separately-traced pieces. See docs/decisions.md for the Option A/B/C
  // observability comparison.
  const tracer = new Tracer();
  const rootSpan = tracer.startSpan("agent.run", "run", {
    attributes: { question: question.slice(0, 200) },
  });
  let finalAnswer = "";
  let runStatus: "ok" | "error" = "ok";
  const resultMetadata: RunSummary["resultMetadata"] = {};

  try {
    try {
      console.error(`Investigating: ${question}\n`);

      const result = await investigate(question, runtime.dependencies, {
        anthropicApiKey: runtime.anthropicApiKey,
        tracer,
        parentSpan: rootSpan,
      });
      finalAnswer = result.answer;

      console.log(`\n${result.answer}\n`);
      console.log(`Evidence (${result.evidence.length}):`);
      for (const item of result.evidence) {
        console.log(
          `  - [${item.source}] ${item.id}: ${item.summary}${item.url ? ` (${item.url})` : ""}`,
        );
      }

      let auditRecord: AuditRecord | undefined;
      if (result.proposedAction) {
        // reviewAndExecute is the only place in this process that touches a
        // write-capable Linear client — used here, never
        // passed to anything the model's tool loop can reach.
        auditRecord = await reviewAndExecute(result.proposedAction, {
          promptForApproval,
          issueWriter: runtime.issueWriter,
          issueTracker: runtime.dependencies.issueTracker,
          tracer,
          parentSpan: rootSpan,
        });
        printAuditRecord(auditRecord);
      }

      resultMetadata.evidenceCount = result.evidence.length;
      resultMetadata.toolCallCount = result.trace.length;
      resultMetadata.proposedAction = result.proposedAction !== undefined;
      // Scalar-only, same privacy boundary as everything else here — never
      // the assessment's summary/blocker prose. Mirrors apps/eval-runner.
      resultMetadata.assessmentPresent = result.assessment !== undefined;
      if (result.assessment) {
        resultMetadata.assessmentVerdict = result.assessment.verdict;
        resultMetadata.assessmentBlockerCount =
          result.assessment.blockers.length;
        resultMetadata.assessmentUncertaintyCount =
          result.assessment.uncertainty?.length ?? 0;
      }
      if (auditRecord) {
        resultMetadata.approvalDecision = auditRecord.decision;
        if (auditRecord.execution) {
          resultMetadata.executionOutcome = auditRecord.execution.outcome;
        }
      }
      for (const [key, value] of Object.entries(resultMetadata)) {
        rootSpan.setAttribute(key, value);
      }
    } finally {
      await runtime.close();
    }
  } catch (err) {
    runStatus = "error";
    throw err;
  } finally {
    rootSpan.end(runStatus);
    console.error("\n=== Trace ===");
    console.error(formatTraceTree(tracer.getSpans()));
    await persistTrace(tracer, { question, finalAnswer, resultMetadata });

    // Best-effort, disabled by default (OTEL_EXPORT_ENABLED unset). Always
    // runs after local JSONL is already durably written — local trace and
    // the investigation's own result are never contingent on this
    // succeeding. See docs/decisions.md.
    const exportResult = await exportTrace(tracer.getSpans());
    if (exportResult.attempted) {
      console.error(
        exportResult.ok
          ? "Trace exported to configured OTLP endpoint."
          : `OTLP export failed (local trace unaffected): ${exportResult.error}`,
      );
    } else if (!exportResult.ok) {
      console.error(`OTLP export not attempted: ${exportResult.error}`);
    }
  }
}

/**
 * `.traces/<traceId>.jsonl` — one file per run, gitignored. Scalar-only
 * span attributes and this explicit {trace, question, finalAnswer,
 * resultMetadata} summary line are the whole contract: no raw Slack/issue
 * text, no prompts, no tool payloads. See docs/decisions.md.
 */
async function persistTrace(
  tracer: Tracer,
  summary: Omit<RunSummary, "traceId">,
): Promise<void> {
  const tracesDir = path.join(repoRoot, ".traces");
  await mkdir(tracesDir, { recursive: true });
  const filePath = path.join(tracesDir, `${tracer.traceId}.jsonl`);
  const content = serializeTraceFile(tracer.getSpans(), {
    traceId: tracer.traceId,
    ...summary,
  });
  await writeFile(filePath, content, "utf-8");
  console.error(`Trace written to ${path.relative(repoRoot, filePath)}`);
}

main().catch((err: unknown) => {
  console.error(
    "Investigation failed:",
    err instanceof Error ? err.message : err,
  );
  process.exit(1);
});
