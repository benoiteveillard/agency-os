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
