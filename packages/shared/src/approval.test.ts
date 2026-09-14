import { describe, expect, it } from "vitest";
import { computeApprovalDigest } from "./approval.js";

const args = {
  teamId: "team-1",
  projectId: "proj-1",
  title: "Restore production deployment credentials",
  description: "Blocks JUS-18.",
  priority: 1,
  id: "11111111-1111-1111-1111-111111111111",
};

describe("computeApprovalDigest", () => {
  it("is deterministic for the same kind and args", () => {
    const a = computeApprovalDigest("linear_create_issue", args);
    const b = computeApprovalDigest("linear_create_issue", args);
    expect(a).toBe(b);
  });

  it("is unaffected by object key insertion order", () => {
    const reordered = {
      id: args.id,
      priority: args.priority,
      description: args.description,
      title: args.title,
      projectId: args.projectId,
      teamId: args.teamId,
    };

    expect(computeApprovalDigest("linear_create_issue", args)).toBe(
      computeApprovalDigest("linear_create_issue", reordered),
    );
  });

  it("changes if any argument value changes", () => {
    const tampered = { ...args, title: "Different title" };

    expect(computeApprovalDigest("linear_create_issue", args)).not.toBe(
      computeApprovalDigest("linear_create_issue", tampered),
    );
  });

  it("changes if the kind changes, even with identical args", () => {
    expect(computeApprovalDigest("linear_create_issue", args)).not.toBe(
      computeApprovalDigest("some_other_kind", args),
    );
  });

  it("produces a 64-character hex sha256 digest", () => {
    const digest = computeApprovalDigest("linear_create_issue", args);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });
});
