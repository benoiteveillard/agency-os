import type { AttributeValue } from "@agency-os/observability";

/**
 * Explicit per-tool whitelist of tool-call input fields safe to record as
 * span attributes — identifiers only (projectSlug, threadTs, a commit ref),
 * never content (title, description, rationale, message text). A tool with
 * no entry here (e.g. propose_linear_issue) gets no extra attributes at
 * all, deliberately: extending this whitelist is how a new identifier
 * becomes traceable, not a default. See docs/decisions.md.
 */
const TOOL_ATTRIBUTE_WHITELIST: Readonly<Record<string, readonly string[]>> = {
  linear_list_project_issues: ["projectSlug"],
  github_list_pull_requests: ["projectSlug"],
  github_get_workflow_run_status: ["projectSlug", "ref"],
  slack_get_channel_messages: ["projectSlug"],
  slack_get_thread: ["projectSlug", "threadTs"],
};

/**
 * Extracts only the whitelisted, scalar-typed fields from a tool call's
 * input for a given tool name. Anything not on the whitelist — including
 * every field of propose_linear_issue — is silently dropped, not passed
 * through. Non-scalar values on a whitelisted key (shouldn't happen given
 * the tool schemas, but not assumed) are dropped too.
 */
export function toolCallAttributes(
  toolName: string,
  input: Record<string, unknown>,
): Record<string, AttributeValue> {
  const allowedKeys = TOOL_ATTRIBUTE_WHITELIST[toolName] ?? [];
  const attributes: Record<string, AttributeValue> = {};
  for (const key of allowedKeys) {
    const value = input[key];
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      attributes[key] = value;
    }
  }
  return attributes;
}
