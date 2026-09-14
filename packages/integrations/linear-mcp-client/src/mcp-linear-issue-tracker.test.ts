import { describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerLinearTools } from "@agency-os/mcp-linear";
import type { IssueTracker, ProjectIssue } from "@agency-os/integration-linear";
import {
  McpLinearIssueTracker,
  type McpToolCaller,
} from "./mcp-linear-issue-tracker.js";

const fakeIssue: ProjectIssue = {
  id: "id-JUS-24",
  identifier: "JUS-24",
  title: "Launch production website",
  url: "https://linear.app/acme/issue/JUS-24",
  state: "Todo",
  stateType: "unstarted",
  priorityLabel: "Urgent",
  dueDate: "2026-09-18",
  overdue: false,
  updatedAt: "2026-09-12T00:00:00.000Z",
  blockedBy: [],
  blocks: [],
};

describe("McpLinearIssueTracker (isolated, fake transport)", () => {
  it("parses a successful tool result into domain data", async () => {
    const fakeClient: McpToolCaller = {
      callTool: async ({ name, arguments: args }) => {
        expect(name).toBe("linear_get_issue");
        expect(args).toEqual({ issueId: "JUS-24" });
        return { content: [{ type: "text", text: JSON.stringify(fakeIssue) }] };
      },
    };

    const tracker = new McpLinearIssueTracker(fakeClient);
    const result = await tracker.getIssue("JUS-24");

    expect(result).toEqual(fakeIssue);
  });

  it("throws with the server's error text when isError is set, matching LinearIssueTracker's failure semantics", async () => {
    const fakeClient: McpToolCaller = {
      callTool: async () => ({
        content: [
          {
            type: "text",
            text: 'Linear: failed to load issue "JUS-24": not found',
          },
        ],
        isError: true,
      }),
    };

    const tracker = new McpLinearIssueTracker(fakeClient);

    await expect(tracker.getIssue("JUS-24")).rejects.toThrow(/not found/);
  });

  it("throws rather than returning undefined when the result has no text content", async () => {
    const fakeClient: McpToolCaller = {
      callTool: async () => ({ content: [] }),
    };

    const tracker = new McpLinearIssueTracker(fakeClient);

    await expect(tracker.getIssue("JUS-24")).rejects.toThrow(
      /returned no content/,
    );
  });
});

describe("McpLinearIssueTracker (real protocol round-trip via InMemoryTransport)", () => {
  it("round-trips listProjectIssues through a real McpServer/Client pair", async () => {
    const serverSideTracker: IssueTracker = {
      listProjectIssues: async (projectId) => ({
        project: {
          id: projectId,
          name: "Acme Website Migration",
          url: "https://linear.app/acme/project/1",
          targetDate: "2026-09-18",
          health: "atRisk",
        },
        issues: [fakeIssue],
      }),
      getIssue: async () => fakeIssue,
    };

    const server = new McpServer({ name: "test-linear", version: "0.0.0" });
    registerLinearTools(server, serverSideTracker);

    const [serverTransport, clientTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const tracker = new McpLinearIssueTracker(client);
    const result = await tracker.listProjectIssues("proj_1");

    expect(result.project.id).toBe("proj_1");
    expect(result.issues).toEqual([fakeIssue]);

    await client.close();
  });

  it("surfaces a tracker failure as a rejected promise, not guessed data", async () => {
    const serverSideTracker: IssueTracker = {
      listProjectIssues: async () => {
        throw new Error('Linear: failed to load project "proj_1": timeout');
      },
      getIssue: async () => fakeIssue,
    };

    const server = new McpServer({ name: "test-linear", version: "0.0.0" });
    registerLinearTools(server, serverSideTracker);

    const [serverTransport, clientTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const tracker = new McpLinearIssueTracker(client);

    await expect(tracker.listProjectIssues("proj_1")).rejects.toThrow(
      /timeout/,
    );

    await client.close();
  });
});
