import { describe, expect, it } from "vitest";
import { Tracer } from "@agency-os/observability";
import { ProgressMapper } from "./progress.js";

describe("curated progress", () => {
  it.each([
    ["linear_list_project_issues", "linear"],
    ["github_list_pull_requests", "github"],
    ["github_get_workflow_run_status", "github"],
    ["slack_get_channel_messages", "slack"],
    ["slack_get_thread", "slack"],
  ])("maps %s without attributes or payloads", (name, source) => {
    const tracer = new Tracer();
    const mapper = new ProgressMapper();
    const span = tracer.startSpan(`tool.${name}`, "tool", {
      attributes: { toolName: name, raw: "SECRET" },
    });
    expect(mapper.poll(tracer.getSpans())).toEqual([
      { event: "source.started", data: { source, activityId: 1 } },
    ]);
    expect(mapper.poll(tracer.getSpans())).toEqual([]);
    span.end("error", { category: "saas_api", message: "SECRET" });
    expect(mapper.poll(tracer.getSpans())).toEqual([
      { event: "source.completed", data: { source, activityId: 1, ok: false } },
    ]);
    expect(mapper.poll(tracer.getSpans())).toEqual([]);
  });
  it("reports short completed spans and both assessment activities exactly once", () => {
    const tracer = new Tracer();
    const mapper = new ProgressMapper();
    tracer.startSpan("model.turn", "model").end("ok");
    tracer.startSpan("tool.submit_assessment", "tool").end("ok");
    const events = mapper.poll(tracer.getSpans());
    expect(events.map((e) => e.event)).toEqual([
      "assessment.started",
      "assessment.completed",
      "assessment.started",
      "assessment.completed",
    ]);
    expect(mapper.poll(tracer.getSpans())).toEqual([]);
  });
  it("ignores arbitrary names, misleading categories, and inherited object keys", () => {
    const tracer = new Tracer();
    tracer.startSpan("tool.arbitrary", "tool").end("ok");
    tracer.startSpan("model.turn", "run").end("ok");
    tracer.startSpan("toString", "tool").end("ok");
    expect(new ProgressMapper().poll(tracer.getSpans())).toEqual([]);
  });
});
