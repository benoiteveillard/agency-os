import { describe, expect, it } from "vitest";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import type { SpanRecord } from "@agency-os/observability";
import { toReadableSpan } from "./map-span.js";

function makeRecord(overrides: Partial<SpanRecord> = {}): SpanRecord {
  return {
    traceId: "e8e0d61130a3278cff21faa25026dc03",
    spanId: "0f24e2b24da0b160",
    name: "agent.run",
    category: "run",
    startTime: "2026-09-14T14:37:47.565Z",
    endTime: "2026-09-14T14:37:50.601Z",
    durationMs: 3036,
    status: "ok",
    attributes: {},
    ...overrides,
  };
}

describe("toReadableSpan", () => {
  it("preserves traceId, spanId, and parentSpanId byte-for-byte — no re-encoding", () => {
    const record = makeRecord({
      spanId: "8fbd2336622f547d",
      parentSpanId: "0f24e2b24da0b160",
    });
    const span = toReadableSpan(record);
    expect(span).not.toBeNull();
    const ctx = span!.spanContext();
    expect(ctx.traceId).toBe(record.traceId);
    expect(ctx.spanId).toBe(record.spanId);
    expect(span!.parentSpanContext?.traceId).toBe(record.traceId);
    expect(span!.parentSpanContext?.spanId).toBe(record.parentSpanId);
  });

  it("omits parentSpanContext for a root span", () => {
    const span = toReadableSpan(makeRecord({ parentSpanId: undefined }));
    expect(span!.parentSpanContext).toBeUndefined();
  });

  it("maps name and category (category becomes a custom attribute, not SpanKind)", () => {
    const span = toReadableSpan(
      makeRecord({ name: "tool.linear_list_project_issues", category: "tool" }),
    );
    expect(span!.name).toBe("tool.linear_list_project_issues");
    expect(span!.kind).toBe(SpanKind.INTERNAL);
    expect(span!.attributes["agency.span.category"]).toBe("tool");
  });

  it("maps ISO timestamps to correct HrTime tuples", () => {
    const span = toReadableSpan(
      makeRecord({
        startTime: "2026-09-14T14:37:47.565Z",
        endTime: "2026-09-14T14:37:50.601Z",
      }),
    );
    const [startSec, startNanos] = span!.startTime;
    const [endSec, endNanos] = span!.endTime;
    expect(new Date(startSec * 1000 + startNanos / 1e6).toISOString()).toBe(
      "2026-09-14T14:37:47.565Z",
    );
    expect(new Date(endSec * 1000 + endNanos / 1e6).toISOString()).toBe(
      "2026-09-14T14:37:50.601Z",
    );
  });

  it("maps the tri-state status directly (unset/ok/error -> UNSET/OK/ERROR)", () => {
    expect(toReadableSpan(makeRecord({ status: "ok" }))!.status.code).toBe(
      SpanStatusCode.OK,
    );
    expect(
      toReadableSpan(makeRecord({ status: "error", errorMessage: "boom" }))!
        .status.code,
    ).toBe(SpanStatusCode.ERROR);
  });

  it("puts errorMessage into status.message and errorCategory into a custom attribute", () => {
    const span = toReadableSpan(
      makeRecord({
        status: "error",
        errorCategory: "saas_api",
        errorMessage: "Linear: failed to load project",
      }),
    );
    expect(span!.status.message).toBe("Linear: failed to load project");
    expect(span!.attributes["agency.error.category"]).toBe("saas_api");
  });

  it("passes through existing scalar attributes unchanged", () => {
    const span = toReadableSpan(
      makeRecord({
        attributes: {
          toolName: "slack_get_thread",
          threadTs: "400.001",
          evidenceCount: 2,
        },
      }),
    );
    expect(span!.attributes.toolName).toBe("slack_get_thread");
    expect(span!.attributes.threadTs).toBe("400.001");
    expect(span!.attributes.evidenceCount).toBe(2);
  });

  it("adds GenAI usage-token aliases for model.turn spans only, never inventing gen_ai.request.model", () => {
    const modelSpan = toReadableSpan(
      makeRecord({
        name: "model.turn",
        category: "model",
        attributes: {
          turn: 0,
          stopReason: "tool_use",
          inputTokens: 3676,
          outputTokens: 214,
        },
      }),
    );
    expect(modelSpan!.attributes["gen_ai.usage.input_tokens"]).toBe(3676);
    expect(modelSpan!.attributes["gen_ai.usage.output_tokens"]).toBe(214);
    expect(modelSpan!.attributes["gen_ai.request.model"]).toBeUndefined();

    const toolSpan = toReadableSpan(
      makeRecord({
        name: "tool.linear_list_project_issues",
        category: "tool",
        attributes: { toolName: "x" },
      }),
    );
    expect(
      Object.keys(toolSpan!.attributes).some((k) => k.startsWith("gen_ai.")),
    ).toBe(false);
  });

  it("returns null for a span that never ended (status unset, no endTime) rather than fabricating one", () => {
    const span = toReadableSpan(
      makeRecord({
        status: "unset",
        endTime: undefined,
        durationMs: undefined,
      }),
    );
    expect(span).toBeNull();
  });

  it("computes duration from durationMs without also exposing it as a duplicate attribute", () => {
    const span = toReadableSpan(makeRecord({ durationMs: 1500 }));
    const [sec, nanos] = span!.duration;
    expect(sec * 1000 + nanos / 1e6).toBe(1500);
    expect(span!.attributes.durationMs).toBeUndefined();
  });
});
