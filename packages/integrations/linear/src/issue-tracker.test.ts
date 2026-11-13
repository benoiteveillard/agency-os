import { describe, expect, it } from "vitest";
import {
  LinearIssueTracker,
  toProjectIssue,
  type RawIssue,
} from "./issue-tracker.js";

function ref(identifier: string) {
  return { id: `id-${identifier}`, identifier, title: `Title ${identifier}` };
}

function rawIssue(overrides: Partial<RawIssue> = {}): RawIssue {
  return {
    id: "id-JUS-18",
    identifier: "JUS-18",
    title: "Run production deployment rehearsal",
    url: "https://linear.app/acme/issue/JUS-18",
    priorityLabel: "High",
    dueDate: null,
    updatedAt: "2026-09-12T00:00:00.000Z",
    state: { name: "Todo", type: "unstarted" },
    relations: { nodes: [], pageInfo: { hasNextPage: false } },
    inverseRelations: { nodes: [], pageInfo: { hasNextPage: false } },
    ...overrides,
  };
}

function projectPage(
  nodes: RawIssue[],
  pageInfo: { hasNextPage: boolean; endCursor?: string | null },
) {
  return {
    project: {
      id: "p1",
      name: "Acme",
      url: "https://linear.app/acme/project/p1",
      targetDate: "2026-09-18",
      health: "atRisk",
      issues: { nodes, pageInfo },
    },
  };
}

describe("toProjectIssue", () => {
  it("resolves both outgoing blocks and incoming blockedBy relations", () => {
    const result = toProjectIssue(
      rawIssue({
        relations: {
          nodes: [{ type: "blocks", relatedIssue: ref("JUS-24") }],
          pageInfo: { hasNextPage: false },
        },
        inverseRelations: {
          nodes: [{ type: "blocks", issue: ref("JUS-19") }],
          pageInfo: { hasNextPage: false },
        },
      }),
    );

    expect(result.blocks).toEqual([ref("JUS-24")]);
    expect(result.blockedBy).toEqual([ref("JUS-19")]);
  });

  it("ignores non-blocks relation types (e.g. duplicate, related)", () => {
    const result = toProjectIssue(
      rawIssue({
        relations: {
          nodes: [{ type: "duplicate", relatedIssue: ref("JUS-2") }],
          pageInfo: { hasNextPage: false },
        },
      }),
    );

    expect(result.blocks).toEqual([]);
    expect(result.blockedBy).toEqual([]);
  });

  it("drops a relation whose referenced issue isn't visible, rather than throwing", () => {
    const result = toProjectIssue(
      rawIssue({
        relations: {
          nodes: [{ type: "blocks", relatedIssue: null }],
          pageInfo: { hasNextPage: false },
        },
      }),
    );

    expect(result.blocks).toEqual([]);
  });

  it("marks an overdue, still-open issue as overdue using the state type", () => {
    const now = new Date("2026-09-12T00:00:00.000Z");
    expect(
      toProjectIssue(rawIssue({ dueDate: "2020-01-01" }), now).overdue,
    ).toBe(true);
    expect(
      toProjectIssue(
        rawIssue({
          dueDate: "2020-01-01",
          state: { name: "Done", type: "completed" },
        }),
        now,
      ).overdue,
    ).toBe(false);
  });
});

describe("LinearIssueTracker.listProjectIssues", () => {
  it("fetches relations in the same request as the issues: one request per page", async () => {
    const calls: Record<string, unknown>[] = [];
    const tracker = new LinearIssueTracker(async (_query, variables) => {
      calls.push(variables);
      return calls.length === 1
        ? projectPage([rawIssue()], { hasNextPage: true, endCursor: "c1" })
        : projectPage([rawIssue({ id: "id-JUS-19", identifier: "JUS-19" })], {
            hasNextPage: false,
          });
    });

    const result = await tracker.listProjectIssues("p1");

    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ projectId: "p1", after: "c1" });
    expect(result.issues.map((issue) => issue.identifier)).toEqual([
      "JUS-18",
      "JUS-19",
    ]);
    expect(result.project).toEqual({
      id: "p1",
      name: "Acme",
      url: "https://linear.app/acme/project/p1",
      targetDate: "2026-09-18",
      health: "atRisk",
    });
    expect(result.truncated).toBe(false);
  });

  it("reports truncation when the page cap is hit", async () => {
    let calls = 0;
    const tracker = new LinearIssueTracker(async () => {
      calls += 1;
      return projectPage([rawIssue({ id: `id-${calls}` })], {
        hasNextPage: true,
        endCursor: `c${calls}`,
      });
    });

    const result = await tracker.listProjectIssues("p1");

    expect(calls).toBe(10);
    expect(result.truncated).toBe(true);
  });

  it("reports truncation when an issue has more relations than were fetched", async () => {
    const tracker = new LinearIssueTracker(async () =>
      projectPage(
        [
          rawIssue({
            inverseRelations: { nodes: [], pageInfo: { hasNextPage: true } },
          }),
        ],
        { hasNextPage: false },
      ),
    );

    expect((await tracker.listProjectIssues("p1")).truncated).toBe(true);
  });

  it("rejects a response that doesn't match the expected shape", async () => {
    const tracker = new LinearIssueTracker(async () => ({ project: null }));

    await expect(tracker.listProjectIssues("p1")).rejects.toThrow(
      /^Linear: failed to load project "p1"/,
    );
  });
});

describe("LinearIssueTracker.getIssue", () => {
  it("loads one issue with its relations in a single request", async () => {
    const calls: Record<string, unknown>[] = [];
    const tracker = new LinearIssueTracker(async (_query, variables) => {
      calls.push(variables);
      return { issue: rawIssue() };
    });

    const issue = await tracker.getIssue("JUS-18");

    expect(calls).toEqual([{ id: "JUS-18" }]);
    expect(issue.identifier).toBe("JUS-18");
  });
});
