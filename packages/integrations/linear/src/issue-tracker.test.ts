import { describe, expect, it } from "vitest";
import { resolveProjectIssue, type IssueLike } from "./issue-tracker.js";

function issueRef(identifier: string) {
  return { id: `id-${identifier}`, identifier, title: `Title ${identifier}` };
}

describe("resolveProjectIssue", () => {
  it("resolves both outgoing blocks and incoming blockedBy relations", async () => {
    const fakeIssue: IssueLike = {
      id: "id-JUS-18",
      identifier: "JUS-18",
      title: "Run production deployment rehearsal",
      url: "https://linear.app/acme/issue/JUS-18",
      priorityLabel: "High",
      dueDate: "2026-09-17",
      updatedAt: new Date("2026-09-12T00:00:00.000Z"),
      state: Promise.resolve({ name: "Todo", type: "unstarted" }),
      relations: async () => ({
        nodes: [
          {
            type: "blocks",
            issue: Promise.resolve(issueRef("JUS-18")),
            relatedIssue: Promise.resolve(issueRef("JUS-24")),
          },
        ],
      }),
      inverseRelations: async () => ({
        nodes: [
          {
            type: "blocks",
            issue: Promise.resolve(issueRef("JUS-19")),
            relatedIssue: Promise.resolve(issueRef("JUS-18")),
          },
        ],
      }),
    };

    const result = await resolveProjectIssue(fakeIssue);

    expect(result.blocks).toEqual([issueRef("JUS-24")]);
    expect(result.blockedBy).toEqual([issueRef("JUS-19")]);
  });

  it("ignores non-blocks relation types (e.g. duplicate, related)", async () => {
    const fakeIssue: IssueLike = {
      id: "id-JUS-1",
      identifier: "JUS-1",
      title: "Some issue",
      url: "https://linear.app/acme/issue/JUS-1",
      priorityLabel: "Low",
      dueDate: null,
      updatedAt: new Date("2026-09-12T00:00:00.000Z"),
      state: Promise.resolve({ name: "Todo", type: "unstarted" }),
      relations: async () => ({
        nodes: [
          {
            type: "duplicate",
            issue: Promise.resolve(issueRef("JUS-1")),
            relatedIssue: Promise.resolve(issueRef("JUS-2")),
          },
        ],
      }),
      inverseRelations: async () => ({ nodes: [] }),
    };

    const result = await resolveProjectIssue(fakeIssue);

    expect(result.blocks).toEqual([]);
    expect(result.blockedBy).toEqual([]);
  });

  it("drops a relation whose referenced issue failed to resolve, rather than throwing", async () => {
    const fakeIssue: IssueLike = {
      id: "id-JUS-5",
      identifier: "JUS-5",
      title: "Validate production analytics tracking",
      url: "https://linear.app/acme/issue/JUS-5",
      priorityLabel: "High",
      dueDate: null,
      updatedAt: new Date("2026-09-12T00:00:00.000Z"),
      state: Promise.resolve({ name: "In Progress", type: "started" }),
      relations: async () => ({
        nodes: [
          {
            type: "blocks",
            issue: Promise.resolve(issueRef("JUS-5")),
            relatedIssue: Promise.resolve(undefined),
          },
        ],
      }),
      inverseRelations: async () => ({ nodes: [] }),
    };

    const result = await resolveProjectIssue(fakeIssue);

    expect(result.blocks).toEqual([]);
  });

  it("marks an overdue, still-open issue as overdue using the resolved state type", async () => {
    const fakeIssue: IssueLike = {
      id: "id-JUS-9",
      identifier: "JUS-9",
      title: "Complete mobile regression testing",
      url: "https://linear.app/acme/issue/JUS-9",
      priorityLabel: "High",
      dueDate: "2020-01-01",
      updatedAt: new Date("2026-09-12T00:00:00.000Z"),
      state: Promise.resolve({ name: "Todo", type: "unstarted" }),
      relations: async () => ({ nodes: [] }),
      inverseRelations: async () => ({ nodes: [] }),
    };

    const result = await resolveProjectIssue(fakeIssue);

    expect(result.overdue).toBe(true);
  });
});
