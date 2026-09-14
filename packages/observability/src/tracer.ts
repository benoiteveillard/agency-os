import { generateSpanId, generateTraceId } from "./ids.js";
import type {
  AttributeValue,
  SpanCategory,
  SpanRecord,
  SpanStatus,
  ErrorCategory,
} from "./types.js";

export interface SpanEndError {
  category: ErrorCategory;
  message: string;
}

export interface Span {
  readonly spanId: string;
  readonly traceId: string;
  setAttribute(key: string, value: AttributeValue | null | undefined): void;
  /** Idempotent — a second call is a no-op, so callers don't need to guard against double-ending in catch/finally paths. */
  end(status: SpanStatus, error?: SpanEndError): void;
}

class SpanImpl implements Span {
  readonly spanId: string;
  readonly traceId: string;
  private readonly record: SpanRecord;
  private ended = false;

  constructor(record: SpanRecord) {
    this.spanId = record.spanId;
    this.traceId = record.traceId;
    this.record = record;
  }

  setAttribute(key: string, value: AttributeValue | null | undefined): void {
    if (value === null || value === undefined) return;
    this.record.attributes[key] = value;
  }

  end(status: SpanStatus, error?: SpanEndError): void {
    if (this.ended) return;
    this.ended = true;

    const endTime = new Date();
    this.record.endTime = endTime.toISOString();
    this.record.durationMs =
      endTime.getTime() - new Date(this.record.startTime).getTime();
    this.record.status = status;
    if (error) {
      this.record.errorCategory = error.category;
      this.record.errorMessage = error.message;
    }
  }
}

export interface StartSpanOptions {
  parent?: Span;
  attributes?: Record<string, AttributeValue | null | undefined>;
}

/**
 * Collects spans for one run explicitly, via parent references passed as
 * plain arguments — not via implicit async-context propagation. This
 * matches how this codebase already flows (investigate() -> tool loop ->
 * executeTool()) and avoids the setup complexity of an async-hooks-based
 * context manager for a benefit (implicit propagation) nothing here needs
 * yet. See docs/decisions.md for the fuller Option A/B/C comparison.
 */
export class Tracer {
  readonly traceId: string;
  private readonly spans: SpanRecord[] = [];

  constructor(traceId: string = generateTraceId()) {
    this.traceId = traceId;
  }

  startSpan(
    name: string,
    category: SpanCategory,
    options: StartSpanOptions = {},
  ): Span {
    const record: SpanRecord = {
      traceId: this.traceId,
      spanId: generateSpanId(),
      parentSpanId: options.parent?.spanId,
      name,
      category,
      startTime: new Date().toISOString(),
      status: "unset",
      attributes: {},
    };

    for (const [key, value] of Object.entries(options.attributes ?? {})) {
      if (value !== null && value !== undefined) record.attributes[key] = value;
    }

    // Pushed by reference — a SpanImpl mutating its own record in place is
    // exactly what getSpans() reflects, including a span that's still
    // "unset" because the process ended before it was closed. That's a
    // deliberate, honest signal (an incomplete span in the trace file),
    // not a bug to guard against.
    this.spans.push(record);
    return new SpanImpl(record);
  }

  getSpans(): SpanRecord[] {
    return this.spans;
  }
}
