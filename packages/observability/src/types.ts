/**
 * Intended future path: SpanRecord → OTel mapping → OTLP / Cloudflare-
 * compatible destination. Every field here is named and shaped to make
 * that mapping mechanical later (see ids.ts for why trace/span IDs are
 * already W3C/OTel-width). No OpenTelemetry dependency exists yet — see
 * docs/decisions.md for when to add one.
 */

export type SpanCategory = "run" | "model" | "tool" | "action" | "approval";

/** Mirrors OTel's tri-state span status model (unset/ok/error). */
export type SpanStatus = "unset" | "ok" | "error";

/**
 * Derived from each integration's own existing error-message conventions
 * (see packages/observability/src/redact.ts), not a new error hierarchy.
 * Deliberately does NOT include a category for "prompt-injection evidence
 * encountered" — see docs/decisions.md for why that's not detected here.
 */
export type ErrorCategory =
  | "model_api"
  | "model_incomplete"
  | "mcp_transport"
  | "timeout"
  | "saas_api"
  | "tool_validation"
  | "digest_mismatch"
  | "unknown";

/**
 * Attributes are scalars only — enforced by this type, not by convention.
 * It is a compile error to attach a raw object (a tool payload, a Slack
 * message, an API response) as an attribute. Anything that needs a
 * snippet must be explicitly truncated by the caller first (see
 * redact.ts's truncate()).
 */
export type AttributeValue = string | number | boolean;

export interface SpanRecord {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  category: SpanCategory;
  startTime: string;
  endTime?: string;
  durationMs?: number;
  status: SpanStatus;
  errorCategory?: ErrorCategory;
  /** Already-concise by convention (existing "Linear: failed to..." style messages), and capped again here regardless. */
  errorMessage?: string;
  attributes: Record<string, AttributeValue>;
}
