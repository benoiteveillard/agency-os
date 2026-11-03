import { describe, expect, it } from "vitest";
import { summarizeWorkflowRuns } from "./workflow-run-status.js";

describe("summarizeWorkflowRuns", () => {
  it("is unknown with no workflow runs — missing evidence, not guessed", () => {
    expect(summarizeWorkflowRuns([])).toEqual({ status: "unknown", runs: [] });
  });

  it("is success when every run completed successfully", () => {
    const result = summarizeWorkflowRuns([
      {
        workflowName: "CI",
        status: "completed",
        conclusion: "success",
        url: "https://x/1",
      },
    ]);
    expect(result.status).toBe("success");
  });

  it("is pending when a run hasn't completed yet, absent failures", () => {
    const result = summarizeWorkflowRuns([
      {
        workflowName: "CI",
        status: "in_progress",
        conclusion: null,
        url: "https://x/1",
      },
    ]);
    expect(result.status).toBe("pending");
  });

  it("is failing when any run's conclusion is a failing one", () => {
    const result = summarizeWorkflowRuns([
      {
        workflowName: "CI",
        status: "completed",
        conclusion: "failure",
        url: "https://x/1",
      },
    ]);
    expect(result.status).toBe("failing");
    expect(result.runs).toEqual([
      {
        workflowName: "CI",
        status: "completed",
        conclusion: "failure",
        url: "https://x/1",
      },
    ]);
  });

  it.each(["startup_failure", "failure", "timed_out", "cancelled"])(
    "is failing for conclusion %s",
    (conclusion) => {
      const result = summarizeWorkflowRuns([
        { workflowName: "CI", status: "completed", conclusion, url: "u" },
      ]);
      expect(result.status).toBe("failing");
    },
  );

  it.each(["skipped", "neutral", "stale", "a_future_github_value"])(
    "is unknown, never success, when the only run concluded %s",
    (conclusion) => {
      const result = summarizeWorkflowRuns([
        { workflowName: "CI", status: "completed", conclusion, url: "u" },
      ]);
      expect(result.status).toBe("unknown");
    },
  );

  it("is success when a skipped workflow sits beside a successful one", () => {
    const result = summarizeWorkflowRuns([
      {
        workflowName: "CI",
        status: "completed",
        conclusion: "success",
        url: "u",
      },
      {
        workflowName: "Docs",
        status: "completed",
        conclusion: "skipped",
        url: "u",
      },
    ]);
    expect(result.status).toBe("success");
  });

  it("is unknown when an unrecognized conclusion sits beside a successful one", () => {
    const result = summarizeWorkflowRuns([
      {
        workflowName: "CI",
        status: "completed",
        conclusion: "success",
        url: "u",
      },
      {
        workflowName: "E2E",
        status: "completed",
        conclusion: "stale",
        url: "u",
      },
    ]);
    expect(result.status).toBe("unknown");
  });

  it("prioritizes failing over pending when both are present across runs", () => {
    const result = summarizeWorkflowRuns([
      {
        workflowName: "CI",
        status: "completed",
        conclusion: "failure",
        url: "https://x/1",
      },
      {
        workflowName: "Deploy",
        status: "in_progress",
        conclusion: null,
        url: "https://x/2",
      },
    ]);
    expect(result.status).toBe("failing");
  });
});
