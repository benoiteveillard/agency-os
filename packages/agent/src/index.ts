export { investigate, dedupeEvidence } from "./runner.js";
export type { InvestigateOptions } from "./runner.js";
export { TOOLS, executeTool } from "./tools.js";
export type {
  AgentDependencies,
  ToolExecutionResult,
  ProposalState,
  AssessmentState,
} from "./tools.js";
export { buildSystemPrompt } from "./prompts.js";
export { reviewAndExecute } from "./approval.js";
export type { ReviewAndExecuteDeps } from "./approval.js";
