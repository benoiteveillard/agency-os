import { readFile } from "node:fs/promises";
import type { ProjectRegistryEntry, ProposedAction } from "@agency-os/shared";
import type { LinearFixtureConfig } from "./fixtures/fixture-issue-tracker.js";
import type { GithubFixtureConfig } from "./fixtures/fixture-pull-request-source.js";
import type { SlackFixtureConfig } from "./fixtures/fixture-slack-source.js";
import type { IssueWriterFixtureConfig } from "./fixtures/fixture-issue-writer.js";

export interface FixtureBundle {
  /** Absent unless the scenario's investigate() path actually calls this source — e.g. an approval_only scenario needs none of these. */
  linear?: LinearFixtureConfig;
  github?: GithubFixtureConfig;
  slack?: SlackFixtureConfig;
  /** Absent unless the scenario expects a write to be attempted. */
  issueWriter?: IssueWriterFixtureConfig;
}

/**
 * One trial's complete instruction, written by the Python orchestrator and
 * read by this process — the only channel between them besides the trace
 * file this process writes out. Everything needed to reproduce a trial is
 * in this file plus the fixture data it references.
 */
export interface EvalRunnerConfig {
  mode: "fixture" | "live";
  /** Absent for approval_only-kind scenarios, which skip investigate() entirely. */
  question?: string;
  /** "none" means: don't invoke reviewAndExecute() even if a proposal occurs — see index.ts. */
  approvalPolicy: "approve" | "reject" | "none";
  outputTracePath: string;
  model?: string;
  /** Required when mode is "fixture"; ignored when mode is "live" (loadProjectRegistry() is used instead). */
  projectRegistry?: Record<string, ProjectRegistryEntry>;
  /** Required when mode is "fixture". */
  fixtures?: FixtureBundle;
  /** Present for approval_only-kind scenarios: reviewAndExecute() is called directly with this, skipping investigate(). */
  proposedAction?: ProposedAction;
}

export async function loadConfig(
  configPath: string,
): Promise<EvalRunnerConfig> {
  const raw = await readFile(configPath, "utf-8");
  const config = JSON.parse(raw) as EvalRunnerConfig;

  if (config.mode !== "fixture" && config.mode !== "live") {
    throw new Error(
      `Config error: mode must be "fixture" or "live", got "${String(config.mode)}"`,
    );
  }
  if (
    config.mode === "fixture" &&
    (config.fixtures === undefined || config.projectRegistry === undefined)
  ) {
    throw new Error(
      'Config error: mode "fixture" requires both "fixtures" (may be {}) and "projectRegistry" (may be {})',
    );
  }
  if (!config.question && !config.proposedAction) {
    throw new Error(
      'Config error: one of "question" (agentic) or "proposedAction" (approval_only) is required',
    );
  }
  if (!config.outputTracePath) {
    throw new Error('Config error: "outputTracePath" is required');
  }

  return config;
}
