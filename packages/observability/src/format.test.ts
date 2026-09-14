import { describe, expect, it } from "vitest";
import { Tracer } from "./tracer.js";
import { formatTraceTree, serializeTraceFile } from "./format.js";
import type { RunSummary } from "./format.js";

function buildSampleTrace(): Tracer {
  const tracer = new Tracer();
  const run = tracer.startSpan("agent.run", "run");
  const model = tracer.startSpan("model.turn", "model", { parent: run });
  model.end("ok");
  const tool = tracer.startSpan("tool.linear_list_project_issues", "tool", {
    parent: run,
    attributes: { toolName: "linear_list_project_issues" },
  });
  tool.end("ok");
  run.end("ok");
  return tracer;
}

describe("formatTraceTree", () => {
  it("indents children under their parent in start order", () => {
    const tracer = buildSampleTrace();
    const tree = formatTraceTree(tracer.getSpans());
    const lines = tree.split("\n");

    expect(lines[0]).toMatch(/^agent\.run /);
    expect(lines[1]).toMatch(/^ {2}model\.turn /);
    expect(lines[2]).toMatch(/^ {2}tool\.linear_list_project_issues /);
  });

  it("marks unfinished spans instead of a bogus duration", () => {
    const tracer = new Tracer();
    tracer.startSpan("agent.run", "run");
    const tree = formatTraceTree(tracer.getSpans());

    expect(tree).toContain("unfinished");
  });

  it("surfaces error category and message under the failing span", () => {
    const tracer = new Tracer();
    const root = tracer.startSpan("agent.run", "run");
    const tool = tracer.startSpan("tool.x", "tool", { parent: root });
    tool.end("error", {
      category: "saas_api",
      message: "Linear: failed to load project",
    });
    root.end("error");

    const tree = formatTraceTree(tracer.getSpans());
    expect(tree).toContain("saas_api: Linear: failed to load project");
  });
});

describe("serializeTraceFile", () => {
  it("writes one JSON line per span plus one run_summary line", () => {
    const tracer = buildSampleTrace();
    const summary: RunSummary = {
      traceId: tracer.traceId,
      question: "Are we still on track to launch Project Acme?",
      finalAnswer: "Yes, on track pending PR #12.",
      resultMetadata: { toolCallCount: 2, approvalRequested: false },
    };

    const output = serializeTraceFile(tracer.getSpans(), summary);
    const lines = output.trimEnd().split("\n");

    expect(lines).toHaveLength(tracer.getSpans().length + 1);

    const parsed = lines.map(
      (line) => JSON.parse(line) as Record<string, unknown>,
    );
    const spanLines = parsed.filter((entry) => entry.type === "span");
    const summaryLines = parsed.filter((entry) => entry.type === "run_summary");

    expect(spanLines).toHaveLength(tracer.getSpans().length);
    expect(summaryLines).toHaveLength(1);
    expect(summaryLines[0]).toMatchObject({
      traceId: tracer.traceId,
      question: summary.question,
      finalAnswer: summary.finalAnswer,
    });
  });

  it("produces output that ends with a trailing newline", () => {
    const tracer = buildSampleTrace();
    const output = serializeTraceFile(tracer.getSpans(), {
      traceId: tracer.traceId,
      question: "q",
      finalAnswer: "a",
      resultMetadata: {},
    });

    expect(output.endsWith("\n")).toBe(true);
  });
});
