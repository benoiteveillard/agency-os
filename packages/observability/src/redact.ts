import type { ErrorCategory } from "./types.js";

export function truncate(value: string, maxLength = 80): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}…`;
}

const MAX_ERROR_MESSAGE_LENGTH = 200;

/**
 * Categorizes an error by the message-prefix conventions each integration
 * already uses ("Linear: failed to...", "Linear MCP tool ... failed:",
 * "GitHub: failed to...", "Slack: failed to...", the Phase 3 digest-
 * mismatch message, and executeTool's own validation errors) — not by
 * inspecting error classes from any specific SDK. Keeps this package
 * dependency-free; model-API failures are categorized at their call site
 * in packages/agent/src/runner.ts instead, since that's the one place
 * that already knows it's calling Anthropic.
 *
 * Deliberately does not attempt to detect "prompt-injection evidence
 * encountered" by scanning message/evidence content — that would
 * reintroduce the keyword/string-matching pattern this project explicitly
 * rejected for Slack evidence (see docs/decisions.md, Phase 2). That
 * question is left to a human or a future Phase 5 eval grader reading the
 * run's final answer, not to runtime categorization here.
 */
export function categorizeError(message: string): ErrorCategory {
  if (/^Model stopped before a complete answer/.test(message))
    return "model_incomplete";
  if (/timed out|exceeded its deadline/i.test(message)) return "timeout";
  if (/^Linear MCP tool/.test(message)) return "mcp_transport";
  if (/digest mismatch/i.test(message)) return "digest_mismatch";
  if (/^(Linear|GitHub|Slack):/.test(message)) return "saas_api";
  if (
    /missing required|invalid ".*" value|^Unknown (tool|project slug)|^Tool call not executed/i.test(
      message,
    )
  ) {
    return "tool_validation";
  }
  return "unknown";
}

export function truncateErrorMessage(message: string): string {
  return truncate(message, MAX_ERROR_MESSAGE_LENGTH);
}
