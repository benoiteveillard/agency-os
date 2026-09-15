import { describe, expect, it, vi } from "vitest";
import {
  computeApprovalDigest,
  type AuditRecord,
  type ProposedAction,
} from "@agency-os/shared";
import { ProposalStore } from "./proposal-store.js";

function proposal(id = "proposal-1"): ProposedAction {
  const args = {
    teamId: "team",
    projectId: "project",
    title: "Fix launch",
    description: "Evidence",
    priority: 1,
    id: "issue-1",
  };
  return {
    id,
    kind: "linear_create_issue",
    args,
    rationale: "Unblock launch",
    proposedAt: new Date(0).toISOString(),
    approvalDigest: computeApprovalDigest("linear_create_issue", args),
  };
}
function audit(
  action: ProposedAction,
  outcome?: "success" | "failure" | "executed_unconfirmed",
): AuditRecord {
  return {
    proposalId: action.id,
    kind: action.kind,
    args: action.args,
    rationale: action.rationale,
    proposedAt: action.proposedAt,
    approvalDigest: action.approvalDigest,
    decision: outcome ? "approved" : "rejected",
    decidedAt: new Date(1).toISOString(),
    ...(outcome
      ? { execution: { startedAt: new Date(1).toISOString(), outcome } }
      : {}),
  };
}

describe("ProposalStore", () => {
  it("keeps the original immutable action and investigation correlation", async () => {
    const store = new ProposalStore();
    const action = proposal();
    store.insert(action, "trace-1");
    (action.args as { title: string }).title = "Tampered";
    action.approvalDigest = "tampered";
    const execute = vi.fn(async (canonical: ProposedAction, trace: string) => {
      expect(trace).toBe("trace-1");
      expect(canonical.args.title).toBe("Fix launch");
      expect(canonical.approvalDigest).toBe(
        computeApprovalDigest(canonical.kind, canonical.args),
      );
      expect(() => {
        (canonical.args as { title: string }).title = "Changed";
      }).toThrow();
      return audit(canonical);
    });
    await store.decide(action.id, "reject", execute);
  });

  it("claims synchronously before awaiting and refuses concurrent/conflicting requests", async () => {
    const store = new ProposalStore();
    const action = proposal();
    store.insert(action, "trace");
    let finish!: (record: AuditRecord) => void;
    const execute = vi.fn(
      () =>
        new Promise<AuditRecord>((resolve) => {
          finish = resolve;
        }),
    );
    const first = store.decide(action.id, "approve", execute);
    await expect(
      store.decide(action.id, "approve", execute),
    ).rejects.toMatchObject({ code: "proposal_in_progress" });
    await expect(
      store.decide(action.id, "reject", execute),
    ).rejects.toMatchObject({ code: "proposal_already_decided" });
    finish(audit(action, "success"));
    const result = await first;
    expect(await store.decide(action.id, "approve", execute)).toEqual(result);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(Object.isFrozen(result.execution)).toBe(true);
  });

  it.each(["success", "failure", "executed_unconfirmed"] as const)(
    "never executes twice after %s",
    async (outcome) => {
      const store = new ProposalStore();
      const action = proposal();
      store.insert(action, "trace");
      const execute = vi.fn(async () => audit(action, outcome));
      await store.decide(action.id, "approve", execute);
      expect(
        (await store.decide(action.id, "approve", execute)).execution?.outcome,
      ).toBe(outcome);
      expect(execute).toHaveBeenCalledTimes(1);
    },
  );

  it("replays rejection and refuses a later approval", async () => {
    const store = new ProposalStore();
    const action = proposal();
    store.insert(action, "trace");
    const execute = vi.fn(async () => audit(action));
    await store.decide(action.id, "reject", execute);
    expect((await store.decide(action.id, "reject", execute)).decision).toBe(
      "rejected",
    );
    await expect(
      store.decide(action.id, "approve", execute),
    ).rejects.toMatchObject({ code: "proposal_already_decided" });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("caches unexpected failure without exposing its cause or retrying", async () => {
    const store = new ProposalStore();
    const action = proposal();
    store.insert(action, "trace");
    const execute = vi.fn(async () => {
      throw new Error("secret provider response");
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(
        store.decide(action.id, "approve", execute),
      ).rejects.toMatchObject({
        code: "proposal_execution_failed",
        message: "proposal_execution_failed",
      });
    }
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("distinguishes expiry from unknown, then releases retained tombstones", async () => {
    let now = 0;
    const store = new ProposalStore({ now: () => now });
    const action = proposal();
    expect(store.insert(action, "trace").expiresAt).toBe(
      new Date(15 * 60_000).toISOString(),
    );
    const execute = vi.fn(async () => audit(action));
    await expect(
      store.decide("unknown", "reject", execute),
    ).rejects.toMatchObject({ code: "unknown_proposal" });
    now = 15 * 60_000;
    await expect(
      store.decide(action.id, "reject", execute),
    ).rejects.toMatchObject({ code: "expired_proposal" });
    now = 30 * 60_000;
    await expect(
      store.decide(action.id, "reject", execute),
    ).rejects.toMatchObject({ code: "unknown_proposal" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("bounds retention without evicting a pending or in-flight proposal", async () => {
    let now = 0;
    const store = new ProposalStore({
      now: () => now,
      ttlMs: 10,
      retentionMs: 10,
      maxEntries: 1,
    });
    const action = proposal();
    store.insert(action, "trace");
    expect(() => store.insert(action, "trace")).toThrow("duplicate_proposal");
    expect(() => store.insert(proposal("other"), "trace")).toThrow(
      "proposal_store_full",
    );
    let finish!: (record: AuditRecord) => void;
    const pending = store.decide(
      action.id,
      "reject",
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    now = 1_000;
    expect(() => store.insert(proposal("other"), "trace")).toThrow(
      "proposal_store_full",
    );
    finish(audit(action));
    await pending;
    now += 10;
    expect(() => store.insert(proposal("other"), "trace")).not.toThrow();
  });
});
