import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import {
  investigate,
  reviewAndExecute,
  type AgentDependencies,
} from "@agency-os/agent";
import type { ApprovalPrompt, AuditRecord } from "@agency-os/shared";
import {
  Tracer,
  serializeTraceFile,
  type RunSummary,
} from "@agency-os/observability";
import { loadConfig } from "./config.js";
import { buildDependencies } from "./build-dependencies.js";
import { runConnectivityCheck } from "./connectivity-check.js";

// Same repo-root .env resolution apps/cli uses — needed for live mode, and
// harmless (unused) for fixture mode.
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
loadDotenv({ path: path.join(repoRoot, ".env") });

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function requireArg(flag: string): string {
  const index = process.argv.indexOf(flag);
  if (index === -1 || !process.argv[index + 1]) {
    throw new Error(`Usage: eval-runner --config <path>`);
  }
  return process.argv[index + 1] as string;
}

function makeApprovalPrompt(
  policy: "approve" | "reject" | "none",
): ApprovalPrompt {
  return async () => {
    if (policy === "approve") return true;
    if (policy === "reject") return false;
    // Guarded against at the call site below — this should be unreachable.
    throw new Error(
      'approvalPolicy is "none" but reviewAndExecute() was invoked.',
    );
  };
}

async function main(): Promise<void> {
  // Standalone diagnostic mode: four independent connectivity checks, no
  // config file, no trace, no model tool loop. Lets --live distinguish
  // "Anthropic is down" from "Linear/GitHub/Slack are down" instead of one
  // unavailable provider making every other one look untested.
  if (process.argv.includes("--connectivity")) {
    const report = await runConnectivityCheck();
    console.log(JSON.stringify(report));
    return;
  }

  const configPath = requireArg("--config");
  const config = await loadConfig(configPath);

  const tracer = new Tracer();
  const rootSpan = tracer.startSpan("agent.run", "run", {
    attributes: {
      mode: config.mode,
      question: (config.question ?? "").slice(0, 200),
    },
  });

  let finalAnswer = "";
  let runStatus: "ok" | "error" = "ok";
  const resultMetadata: RunSummary["resultMetadata"] = {};
  let evalArtifacts: RunSummary["evalArtifacts"];
  let closeLiveMcpClient: (() => Promise<void>) | undefined;

  try {
    const deps = await buildDependencies(config);
    closeLiveMcpClient = deps.closeLiveMcpClient;

    if (config.proposedAction) {
      // approval_only kind: exercise reviewAndExecute() directly, no model
      // involved at all.
      const auditRecord = await reviewAndExecute(config.proposedAction, {
        promptForApproval: makeApprovalPrompt(config.approvalPolicy),
        issueWriter: deps.issueWriter,
        issueTracker: deps.issueTracker,
        tracer,
        parentSpan: rootSpan,
      });
      applyAuditMetadata(resultMetadata, auditRecord);
    } else {
      const anthropicApiKey = requireEnv("ANTHROPIC_API_KEY");
      const agentDeps: AgentDependencies = {
        issueTracker: deps.issueTracker,
        pullRequestSource: deps.pullRequestSource,
        slackMessageSource: deps.slackMessageSource,
        projectRegistry: deps.projectRegistry,
      };

      const result = await investigate(config.question ?? "", agentDeps, {
        anthropicApiKey,
        model: config.model,
        ...(config.now ? { now: new Date(config.now) } : {}),
        tracer,
        parentSpan: rootSpan,
      });
      finalAnswer = result.answer;
      if (config.mode === "fixture") {
        evalArtifacts = {
          ...(result.proposedAction
            ? {
                proposal: {
                  title: result.proposedAction.args.title,
                  description: result.proposedAction.args.description,
                  rationale: result.proposedAction.rationale,
                },
              }
            : {}),
          blockerTitles:
            result.assessment?.blockers.map((blocker) => blocker.title) ?? [],
        };
      }
      resultMetadata.evidenceCount = result.evidence.length;
      resultMetadata.toolCallCount = result.trace.length;
      resultMetadata.proposedAction = result.proposedAction !== undefined;
      // Scalar-only, same privacy boundary as everything else in
      // resultMetadata (see packages/observability/src/format.ts) — never
      // the assessment's summary/blocker prose, only safe facts a grader
      // needs: whether one was submitted, its verdict, and shape counts.
      resultMetadata.assessmentPresent = result.assessment !== undefined;
      if (result.assessment) {
        resultMetadata.assessmentVerdict = result.assessment.verdict;
        resultMetadata.assessmentBlockerCount =
          result.assessment.blockers.length;
        resultMetadata.assessmentUncertaintyCount =
          result.assessment.uncertainty?.length ?? 0;
      }

      if (result.proposedAction) {
        if (config.approvalPolicy === "none") {
          // A proposal occurred even though this scenario didn't expect
          // one. Record that fact for the report; do NOT default to
          // approving or rejecting on its behalf.
          resultMetadata.approvalDecision = "skipped_no_policy_configured";
        } else {
          const auditRecord = await reviewAndExecute(result.proposedAction, {
            promptForApproval: makeApprovalPrompt(config.approvalPolicy),
            issueWriter: deps.issueWriter,
            issueTracker: deps.issueTracker,
            tracer,
            parentSpan: rootSpan,
          });
          applyAuditMetadata(resultMetadata, auditRecord);
        }
      }
    }

    for (const [key, value] of Object.entries(resultMetadata)) {
      rootSpan.setAttribute(key, value);
    }
  } catch (err) {
    runStatus = "error";
    resultMetadata.runnerError = (err as Error).message.slice(0, 200);
    console.error("eval-runner failed:", (err as Error).message);
  } finally {
    if (closeLiveMcpClient) await closeLiveMcpClient();

    rootSpan.end(runStatus);
    await mkdir(path.dirname(config.outputTracePath), { recursive: true });
    await writeFile(
      config.outputTracePath,
      serializeTraceFile(tracer.getSpans(), {
        traceId: tracer.traceId,
        question: config.question ?? "",
        finalAnswer,
        resultMetadata,
        ...(evalArtifacts ? { evalArtifacts } : {}),
      }),
      "utf-8",
    );
  }

  if (runStatus === "error") process.exitCode = 1;
}

function applyAuditMetadata(
  resultMetadata: RunSummary["resultMetadata"],
  auditRecord: AuditRecord,
): void {
  resultMetadata.approvalDecision = auditRecord.decision;
  if (auditRecord.execution) {
    resultMetadata.executionOutcome = auditRecord.execution.outcome;
  }
}

main().catch((err: unknown) => {
  console.error(
    "eval-runner crashed before producing a trace:",
    err instanceof Error ? err.message : err,
  );
  process.exit(1);
});
