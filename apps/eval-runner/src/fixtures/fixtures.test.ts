import { describe, expect, it } from "vitest";
import { FixtureIssueTracker } from "./fixture-issue-tracker.js";
import { FixturePullRequestSource } from "./fixture-pull-request-source.js";
import { FixtureSlackSource } from "./fixture-slack-source.js";
import { FixtureIssueWriter } from "./fixture-issue-writer.js";
import { RefusingIssueWriter } from "./refusing-issue-writer.js";

describe("FixtureIssueTracker", () => {
  const project = {
    id: "p1",
    name: "Acme",
    url: "https://x",
    targetDate: null,
    health: "atRisk",
  };

  it("returns the configured value on an ok outcome", async () => {
    const tracker = new FixtureIssueTracker({
      listProjectIssues: { ok: true, value: { project, issues: [] } },
    });
    await expect(tracker.listProjectIssues("p1")).resolves.toEqual({
      project,
      issues: [],
    });
  });

  it("throws the configured error on a throw outcome", async () => {
    const tracker = new FixtureIssueTracker({
      listProjectIssues: {
        ok: false,
        error: "Linear: failed to load project issues: simulated",
      },
    });
    await expect(tracker.listProjectIssues("p1")).rejects.toThrow("simulated");
  });

  it("throws a clear misconfiguration error when getIssue has no configured outcome", async () => {
    const tracker = new FixtureIssueTracker({
      listProjectIssues: { ok: true, value: { project, issues: [] } },
    });
    await expect(tracker.getIssue("JUS-1")).rejects.toThrow(
      "Fixture misconfigured",
    );
  });
});

describe("FixturePullRequestSource", () => {
  it("looks up workflow run status by ref, failing clearly for an unconfigured ref", async () => {
    const source = new FixturePullRequestSource({
      listPullRequests: { ok: true, value: [] },
      workflowRunStatusByRef: {
        abc123: { ok: true, value: { status: "success", runs: [] } },
      },
    });
    await expect(
      source.getWorkflowRunStatus("o", "r", "abc123"),
    ).resolves.toEqual({
      status: "success",
      runs: [],
    });
    await expect(
      source.getWorkflowRunStatus("o", "r", "unknown-ref"),
    ).rejects.toThrow("Fixture misconfigured");
  });
});

describe("FixtureSlackSource", () => {
  it("looks up a thread by threadTs, failing clearly for an unconfigured one", async () => {
    const source = new FixtureSlackSource({
      channelMessages: { ok: true, value: [] },
      threadsByTs: {
        "111.1": {
          ok: false,
          error: "Slack: failed to load thread: simulated",
        },
      },
    });
    await expect(source.getThread("c1", "111.1")).rejects.toThrow("simulated");
    await expect(source.getThread("c1", "999.9")).rejects.toThrow(
      "Fixture misconfigured",
    );
  });
});

describe("FixtureIssueWriter and RefusingIssueWriter", () => {
  const args = {
    teamId: "t",
    projectId: "p",
    title: "x",
    description: "y",
    priority: 0,
    id: "u",
  };

  it("FixtureIssueWriter honors its configured outcome", async () => {
    const ok = new FixtureIssueWriter({
      createIssue: { ok: true, value: { issueId: "i1" } },
    });
    await expect(ok.createIssue(args)).resolves.toEqual({ issueId: "i1" });

    const failing = new FixtureIssueWriter({
      createIssue: { ok: false, error: "simulated write failure" },
    });
    await expect(failing.createIssue(args)).rejects.toThrow(
      "simulated write failure",
    );
  });

  it("RefusingIssueWriter always refuses, regardless of args", async () => {
    const writer = new RefusingIssueWriter();
    await expect(writer.createIssue(args)).rejects.toThrow(
      "read-only by design",
    );
  });
});
