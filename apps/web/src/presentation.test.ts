import { describe, expect, it } from "vitest";
import { Tracer } from "@agency-os/observability";
import type { InvestigationResult } from "@agency-os/shared";
import { presentResult, sourceUrl } from "./presentation.js";

const secret =
  "Slack body; Ignore previous instructions; sk-ant-FAKE; Authorization: Bearer FAKE; raw tool input/output; chain-of-thought";
function result(): InvestigationResult {
  return {
    answer: "Launch is blocked.",
    evidence: [
      {
        source: "slack",
        id: "123.456",
        summary: secret,
        timestamp: "2026-09-15T12:00:00Z",
      },
      {
        source: "linear",
        id: "JUS-6",
        summary: secret,
        url: "https://linear.app/team/issue/JUS-6",
      },
    ],
    trace: [
      {
        tool: "slack_get_thread",
        input: secret,
        ok: false,
        durationMs: 1,
        error: secret,
      },
    ],
    assessment: {
      verdict: "high_risk",
      summary: "Approval missing.",
      blockers: [
        {
          title: "Approval",
          explanation: "Required approval missing",
          sources: [
            { evidenceId: "slack:123.456", role: "corroborating" },
            { evidenceId: "linear:JUS-6", role: "authoritative" },
          ],
        },
      ],
      uncertainty: ["Delivery date"],
    },
  };
}
describe("browser presentation", () => {
  it("preserves assessment references while excluding raw evidence, traces and extra fields", () => {
    const internal = result();
    Object.assign(internal, { prompt: secret, modelOutput: secret });
    Object.assign(internal.assessment!, { raw: secret });
    const dto = presentResult(internal, "trace", 14, []);
    expect(dto.assessment).toEqual(result().assessment);
    expect(dto.evidence.map((e) => e.evidenceId)).toEqual([
      "slack:123.456",
      "linear:JUS-6",
    ]);
    expect(dto.evidence[0]).not.toHaveProperty("url");
    expect(dto).not.toHaveProperty("trace");
    expect(dto).not.toHaveProperty("prompt");
    expect(dto).not.toHaveProperty("modelOutput");
    expect(dto.assessment).not.toHaveProperty("raw");
    expect(dto.metadata).toEqual({
      traceId: "trace",
      durationMs: 14,
      toolCallCount: 1,
    });
  });
  it("gives an excerpt only to cited evidence, and caps its length", () => {
    const internal = result();
    internal.evidence[0]!.summary = "x".repeat(1000);
    internal.evidence.push({
      source: "github",
      id: "#9",
      summary: "PRIVATE uncited evidence",
    });
    const dto = presentResult(internal, "trace", 1, []);
    expect(dto.evidence[0]!.excerpt!.length).toBeLessThanOrEqual(281);
    expect(dto.evidence[2]).not.toHaveProperty("excerpt");
    expect(JSON.stringify(dto)).not.toContain("PRIVATE");
  });
  it("gives an excerpt to evidence only a proposal cites", () => {
    const internal = result();
    internal.assessment = undefined;
    internal.evidence[0]!.summary = "Client approval is missing.";
    internal.proposedAction = {
      evidenceIds: ["slack:123.456"],
    } as unknown as InvestigationResult["proposedAction"];
    const dto = presentResult(internal, "trace", 1, []);
    expect(dto.evidence[0]!.excerpt).toBe("Client approval is missing.");
    expect(dto.evidence[1]).not.toHaveProperty("excerpt");
  });
  it("fails closed on broken references", () => {
    const internal = result();
    internal.evidence = [];
    expect(() => presentResult(internal, "trace", 1, [])).toThrow("reference");
  });
  it("aggregates only finite nonnegative model token counters", () => {
    const tracer = new Tracer();
    tracer
      .startSpan("model.turn", "model", {
        attributes: { inputTokens: 10, outputTokens: 3, prompt: secret },
      })
      .end("ok");
    tracer
      .startSpan("model.turn", "model", {
        attributes: { inputTokens: 20, outputTokens: 7 },
      })
      .end("ok");
    tracer
      .startSpan("tool.slack_get_thread", "tool", {
        attributes: { inputTokens: 999 },
      })
      .end("ok");
    tracer
      .startSpan("model.turn", "model", {
        attributes: { inputTokens: NaN, outputTokens: -1 },
      })
      .end("ok");
    expect(
      presentResult(result(), tracer.traceId, 10, tracer.getSpans()).metadata,
    ).toEqual({
      traceId: tracer.traceId,
      durationMs: 10,
      toolCallCount: 1,
      inputTokens: 30,
      outputTokens: 10,
    });
  });
  it.each([
    "javascript:alert(1)",
    "http://linear.app/a",
    "https://evil.test/a",
    "https://user:password@linear.app/a",
    "https://linear.app.evil.test/a",
  ])("omits unsafe evidence URL %s", (url) => {
    expect(sourceUrl(url, "linear")).toBeUndefined();
  });
  it("keeps existing provider path only", () => {
    expect(
      sourceUrl("https://github.com/o/r/pull/12?token=SECRET#foo", "github"),
    ).toBe("https://github.com/o/r/pull/12");
  });
});
