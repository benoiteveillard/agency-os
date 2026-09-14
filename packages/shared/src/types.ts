/**
 * A single retrieved fact backing part of the agent's answer.
 * Every important claim in a final answer should trace back to at least one of these.
 */
export interface Evidence {
  source: "linear" | "github";
  /** Provider-native identifier (e.g. Linear issue identifier, PR number) so a human can look it up. */
  id: string;
  url?: string;
  summary: string;
  timestamp?: string;
}

/** One tool invocation within an investigation, kept for future tracing/observability. */
export interface ToolCallRecord {
  tool: string;
  input: unknown;
  ok: boolean;
  durationMs: number;
  error?: string;
}

export interface InvestigationResult {
  answer: string;
  evidence: Evidence[];
  trace: ToolCallRecord[];
}
