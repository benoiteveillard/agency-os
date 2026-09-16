import { describe, expect, it, vi } from "vitest";
import {
  computeApprovalDigest,
  type LinearCreateIssueArgs,
  type ProposedAction,
} from "@agency-os/shared";
import type { IssueTracker, ProjectIssue } from "@agency-os/integration-linear";
import { Tracer } from "@agency-os/observability";
import { reviewAndExecute, type ReviewAndExecuteDeps } from "./approval.js";

const args: LinearCreateIssueArgs = {
  teamId: "team-1",
  projectId: "proj-1",
  title: "Restore production deployment credentials",
  description: "Blocks JUS-18, which blocks JUS-24. Cited from JUS-19.",
  priority: 1,
  id: "11111111-1111-1111-1111-111111111111",
};

function makeAction(overrides: Partial<ProposedAction> = {}): ProposedAction {
  return {
    id: "proposal-1",
    kind: "linear_create_issue",
    args,
    rationale:
      "Deployment rehearsal is blocked on missing credentials with no tracking issue.",
    proposedAt: "2026-09-14T00:00:00.000Z",
    approvalDigest: computeApprovalDigest("linear_create_issue", args),
    ...overrides,
  };
}

const fakeCreatedIssue: ProjectIssue = {
  id: "issue-uuid-1",
  identifier: "JUS-30",
  title: args.title,
  url: "https://linear.app/justa-agence/issue/JUS-30",
  state: "Todo",
  stateType: "unstarted",
  priorityLabel: "Urgent",
  dueDate: null,
  overdue: false,
  updatedAt: "2026-09-14T00:00:00.000Z",
  blockedBy: [],
  blocks: [],
};

function makeDeps(
  overrides: Partial<ReviewAndExecuteDeps> = {},
): ReviewAndExecuteDeps {
  const tracer = new Tracer();
  return {
    promptForApproval: vi.fn(async () => true),
    issueWriter: {
      createIssue: vi.fn(async () => ({ issueId: "issue-uuid-1" })),
    },
    issueTracker: {
      listProjectIssues: vi.fn(),
      getIssue: vi.fn(async () => fakeCreatedIssue),
    } as unknown as IssueTracker,
    tracer,
    parentSpan: tracer.startSpan("agent.run", "run"),
    ...overrides,
  };
}

describe("reviewAndExecute", () => {
  it("does not call issueWriter when rejected", async () => {
    const deps = makeDeps({ promptForApproval: vi.fn(async () => false) });

    const record = await reviewAndExecute(makeAction(), deps);

    expect(record.decision).toBe("rejected");
    expect(record.execution).toBeUndefined();
    expect(deps.issueWriter.createIssue).not.toHaveBeenCalled();
  });

  it("executes and reads back the created issue when approved", async () => {
    const deps = makeDeps();

    const record = await reviewAndExecute(makeAction(), deps);

    expect(record.decision).toBe("approved");
    expect(record.execution?.outcome).toBe("success");
    expect(record.execution?.createdIssue).toEqual({
      id: "issue-uuid-1",
      identifier: "JUS-30",
      title: args.title,
      url: "https://linear.app/justa-agence/issue/JUS-30",
    });
    expect(deps.issueWriter.createIssue).toHaveBeenCalledWith(args);

    const names = deps.tracer.getSpans().map((span) => span.name);
    expect(names).toEqual([
      "agent.run",
      "approval.decision",
      "action.execute",
      "action.confirm",
    ]);
  });

  it("refuses execution when the args no longer match the approved digest", async () => {
    const tamperedAction = makeAction({
      args: { ...args, title: "TAMPERED TITLE" },
    });
    const deps = makeDeps();

    const record = await reviewAndExecute(tamperedAction, deps);

    expect(record.execution?.outcome).toBe("failure");
    expect(record.execution?.error).toContain("digest mismatch");
    expect(deps.issueWriter.createIssue).not.toHaveBeenCalled();
  });

  it("reports failure, not a crash, when the write itself fails", async () => {
    const deps = makeDeps({
      issueWriter: {
        createIssue: vi.fn(async () => {
          throw new Error("Linear: failed to create issue: network timeout");
        }),
      },
    });

    const record = await reviewAndExecute(makeAction(), deps);

    expect(record.execution?.outcome).toBe("failure");
    expect(record.execution?.error).toContain("network timeout");
  });

  it("reports executed_unconfirmed when the write succeeds but read-back fails", async () => {
    const deps = makeDeps({
      issueTracker: {
        listProjectIssues: vi.fn(),
        getIssue: vi.fn(async () => {
          throw new Error("Linear: failed to load issue: timeout");
        }),
      } as unknown as IssueTracker,
    });

    const record = await reviewAndExecute(makeAction(), deps);

    expect(record.execution?.outcome).toBe("executed_unconfirmed");
    expect(record.execution?.error).toContain("timeout");
    // The write DID happen — this must not be reported as a plain failure.
    expect(deps.issueWriter.createIssue).toHaveBeenCalled();
  });

  // Phase 7.4: public-demo write policy (DEMO_WRITE_MODE=disabled).
  describe("writesEnabled: false", () => {
    it("records a genuine approval but never calls issueWriter", async () => {
      const deps = makeDeps({ writesEnabled: false });

      const record = await reviewAndExecute(makeAction(), deps);

      expect(record.decision).toBe("approved");
      expect(record.execution?.outcome).toBe("execution_disabled");
      expect(record.execution?.createdIssue).toBeUndefined();
      expect(record.execution?.error).toBeUndefined();
      expect(deps.issueWriter.createIssue).not.toHaveBeenCalled();
      expect(deps.issueTracker.getIssue).not.toHaveBeenCalled();
    });

    it("still refuses on rejection exactly as when writes are enabled", async () => {
      const deps = makeDeps({
        writesEnabled: false,
        promptForApproval: vi.fn(async () => false),
      });

      const record = await reviewAndExecute(makeAction(), deps);

      expect(record.decision).toBe("rejected");
      expect(record.execution).toBeUndefined();
      expect(deps.issueWriter.createIssue).not.toHaveBeenCalled();
    });

    it("does not compute or check the approval digest before short-circuiting", async () => {
      // Tampered args would normally be caught by the digest check inside
      // the execute path — with writes disabled, execution never reaches
      // that check at all, since no write can happen either way.
      const tamperedAction = makeAction({
        args: { ...args, title: "TAMPERED TITLE" },
      });
      const deps = makeDeps({ writesEnabled: false });

      const record = await reviewAndExecute(tamperedAction, deps);

      expect(record.execution?.outcome).toBe("execution_disabled");
      expect(deps.issueWriter.createIssue).not.toHaveBeenCalled();
    });

    it("defaults to writes enabled when unset (CLI/local behavior unchanged)", async () => {
      const deps = makeDeps();
      expect(deps.writesEnabled).toBeUndefined();

      const record = await reviewAndExecute(makeAction(), deps);

      expect(record.execution?.outcome).toBe("success");
      expect(deps.issueWriter.createIssue).toHaveBeenCalled();
    });
  });
});
