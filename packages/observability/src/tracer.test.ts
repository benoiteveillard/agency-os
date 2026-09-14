import { describe, expect, it } from "vitest";
import { Tracer } from "./tracer.js";

describe("Tracer", () => {
  it("gives every span the same traceId", () => {
    const tracer = new Tracer();
    const a = tracer.startSpan("agent.run", "run");
    const b = tracer.startSpan("model.turn", "model", { parent: a });

    expect(a.traceId).toBe(tracer.traceId);
    expect(b.traceId).toBe(tracer.traceId);
  });

  it("records explicit parent/child linkage via parentSpanId", () => {
    const tracer = new Tracer();
    const root = tracer.startSpan("agent.run", "run");
    const child = tracer.startSpan("tool.linear_list_project_issues", "tool", {
      parent: root,
    });

    const [rootRecord, childRecord] = tracer.getSpans();
    expect(rootRecord?.parentSpanId).toBeUndefined();
    expect(childRecord?.parentSpanId).toBe(root.spanId);
    expect(childRecord?.spanId).toBe(child.spanId);
  });

  it("computes duration and sets status on end()", () => {
    const tracer = new Tracer();
    const span = tracer.startSpan("tool.x", "tool");
    span.end("ok");

    const [record] = tracer.getSpans();
    expect(record?.status).toBe("ok");
    expect(record?.endTime).toBeDefined();
    expect(record?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("leaves unfinished spans as status unset with no endTime — an honest signal, not a bug", () => {
    const tracer = new Tracer();
    tracer.startSpan("tool.x", "tool");

    const [record] = tracer.getSpans();
    expect(record?.status).toBe("unset");
    expect(record?.endTime).toBeUndefined();
  });

  it("records error category and message on error end()", () => {
    const tracer = new Tracer();
    const span = tracer.startSpan("tool.x", "tool");
    span.end("error", {
      category: "saas_api",
      message: "Linear: failed to load project",
    });

    const [record] = tracer.getSpans();
    expect(record?.status).toBe("error");
    expect(record?.errorCategory).toBe("saas_api");
    expect(record?.errorMessage).toBe("Linear: failed to load project");
  });

  it("ignores a second end() call", () => {
    const tracer = new Tracer();
    const span = tracer.startSpan("tool.x", "tool");
    span.end("ok");
    const firstEndTime = tracer.getSpans()[0]?.endTime;

    span.end("error", { category: "unknown", message: "should not apply" });

    const [record] = tracer.getSpans();
    expect(record?.status).toBe("ok");
    expect(record?.endTime).toBe(firstEndTime);
  });

  it("drops null/undefined attributes rather than storing them", () => {
    const tracer = new Tracer();
    const span = tracer.startSpan("tool.x", "tool", {
      attributes: {
        toolName: "x",
        cacheReadInputTokens: null,
        other: undefined,
      },
    });
    span.setAttribute("afterEnd", 5);
    span.setAttribute("skipMe", undefined);

    const [record] = tracer.getSpans();
    expect(record?.attributes).toEqual({ toolName: "x", afterEnd: 5 });
  });
});
