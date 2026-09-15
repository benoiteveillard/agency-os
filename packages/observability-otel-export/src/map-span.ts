import { SpanKind, SpanStatusCode, type SpanContext } from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import type { ReadableSpan } from "@opentelemetry/sdk-trace";
import type {
  AttributeValue,
  SpanRecord,
  SpanStatus,
} from "@agency-os/observability";

const SERVICE_NAME = "agency-os-agent";
const resource = resourceFromAttributes({ "service.name": SERVICE_NAME });
const instrumentationScope = { name: "@agency-os/observability-otel-export" };

const STATUS_MAP: Record<SpanStatus, SpanStatusCode> = {
  unset: SpanStatusCode.UNSET,
  ok: SpanStatusCode.OK,
  error: SpanStatusCode.ERROR,
};

/**
 * GenAI semantic-convention aliases for model.turn spans only — checked
 * directly against the OTel semantic-conventions repo: still experimental/
 * unstable as of this implementation (no OTEL_SEMCONV_STABILITY_OPT_IN
 * equivalent exists yet for a hand-built exporter, so these are emitted
 * unconditionally as additions, never replacing our own attribute names).
 * Only aliases values that already exist in SpanRecord.attributes — no new
 * data. gen_ai.request.model is deliberately NOT aliased: the model string
 * (e.g. "claude-sonnet-5") is never recorded in SpanRecord.attributes today
 * (see packages/agent/src/runner.ts), and fabricating it here from the
 * runner's DEFAULT_MODEL constant would silently drift from the real
 * runtime value whenever a caller passes a different `model` option.
 */
function genAiAliases(record: SpanRecord): Record<string, AttributeValue> {
  if (record.category !== "model") return {};
  const aliases: Record<string, AttributeValue> = {};
  if (typeof record.attributes.inputTokens === "number") {
    aliases["gen_ai.usage.input_tokens"] = record.attributes.inputTokens;
  }
  if (typeof record.attributes.outputTokens === "number") {
    aliases["gen_ai.usage.output_tokens"] = record.attributes.outputTokens;
  }
  return aliases;
}

function isoToHrTime(iso: string): [number, number] {
  const ms = new Date(iso).getTime();
  return [Math.floor(ms / 1000), (ms % 1000) * 1e6];
}

function msToHrTime(ms: number): [number, number] {
  return [Math.floor(ms / 1000), (ms % 1000) * 1e6];
}

/**
 * Maps one already-completed SpanRecord to a plain object satisfying
 * OTel's ReadableSpan interface — no real Tracer/Span SDK instance
 * involved, matching "adapt completed SpanRecord[]" rather than
 * introducing a second, live instrumentation path. Trace ID / span ID /
 * parent span ID are passed through byte-for-byte: Phase 4 chose their
 * exact width (128-bit / 64-bit hex) specifically so this mapping needs no
 * re-encoding — verified directly against OTLP's wire type
 * (`ISpan.traceId: string | Uint8Array` accepts our hex string as-is).
 *
 * Returns null for a span that never ended (status "unset", no endTime) —
 * an honest signal locally (see packages/observability/src/tracer.ts), but
 * OTLP's wire format has no clean way to represent "still in flight" in a
 * batch exported after a run completes, so these are skipped rather than
 * exported with a fabricated end time.
 */
export function toReadableSpan(record: SpanRecord): ReadableSpan | null {
  if (record.status === "unset" || !record.endTime) return null;

  const spanContext: SpanContext = {
    traceId: record.traceId,
    spanId: record.spanId,
    traceFlags: 1, // sampled
    isRemote: false,
  };

  const attributes: Record<string, AttributeValue> = {
    ...record.attributes,
    ...genAiAliases(record),
    "agency.span.category": record.category,
  };
  if (record.errorCategory) {
    attributes["agency.error.category"] = record.errorCategory;
  }

  return {
    name: record.name,
    kind: SpanKind.INTERNAL,
    spanContext: () => spanContext,
    parentSpanContext: record.parentSpanId
      ? {
          traceId: record.traceId,
          spanId: record.parentSpanId,
          traceFlags: 1,
          isRemote: false,
        }
      : undefined,
    startTime: isoToHrTime(record.startTime),
    endTime: isoToHrTime(record.endTime),
    status: {
      code: STATUS_MAP[record.status],
      // Already capped at write time (truncateErrorMessage, 200 chars —
      // see packages/observability/src/redact.ts); no further truncation
      // needed here.
      message: record.errorMessage,
    },
    attributes,
    links: [],
    events: [],
    duration: msToHrTime(record.durationMs ?? 0),
    ended: true,
    resource,
    instrumentationScope,
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
  };
}
