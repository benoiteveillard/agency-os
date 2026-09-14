import { describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type {
  IssueTracker,
  ProjectIssuesResult,
  ProjectIssue,
} from "@agency-os/integration-linear";
import { registerLinearTools } from "./tools.js";

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
  blockedBy: [
    { id: "id-JUS-19", identifier: "JUS-19", title: "Restore credentials" },
  ],
  blocks: [],
};

const fakeProjectIssues: ProjectIssuesResult = {
  project: {
    id: "proj_1",
    name: "Acme Website Migration",
    url: "https://linear.app/acme/project/1",
    targetDate: "2026-09-18",
    health: "atRisk",
  },
  issues: [fakeIssue],
};

/**
 * Connects a real McpServer (with our tools registered against a fake
 * IssueTracker) to a real Client over an in-process transport pair — the
 * SDK's own supported pattern for testing servers without a subprocess or
 * network hop. Exercises the real registration, schema validation, and
 * content/isError serialization, not a hand-mocked guess at their shape.
 */
async function connectedClient(issueTracker: IssueTracker): Promise<Client> {
  const server = new McpServer({ name: "test-linear", version: "0.0.0" });
  registerLinearTools(server, issueTracker);

  const [serverTransport, clientTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return client;
}

describe("registerLinearTools", () => {
  it("linear_list_project_issues returns the tracker's structured domain data as JSON text", async () => {
    const issueTracker: IssueTracker = {
      listProjectIssues: async () => fakeProjectIssues,
      getIssue: async () => fakeIssue,
    };
    const client = await connectedClient(issueTracker);

    const result = await client.callTool({
      name: "linear_list_project_issues",
      arguments: { projectId: "proj_1" },
    });

    expect(result.isError).toBeFalsy();
    const [block] = result.content as Array<{ type: string; text: string }>;
    expect(block?.type).toBe("text");
    expect(JSON.parse(block!.text)).toEqual(fakeProjectIssues);

    await client.close();
  });

  it("linear_get_issue returns a single issue's structured domain data", async () => {
    const issueTracker: IssueTracker = {
      listProjectIssues: async () => fakeProjectIssues,
      getIssue: async (idOrIdentifier) => {
        expect(idOrIdentifier).toBe("JUS-24");
        return fakeIssue;
      },
    };
    const client = await connectedClient(issueTracker);

    const result = await client.callTool({
      name: "linear_get_issue",
      arguments: { issueId: "JUS-24" },
    });

    expect(result.isError).toBeFalsy();
    const [block] = result.content as Array<{ type: string; text: string }>;
    expect(JSON.parse(block!.text)).toEqual(fakeIssue);

    await client.close();
  });

  it("returns an MCP error result — not a thrown protocol error — when the tracker fails", async () => {
    const issueTracker: IssueTracker = {
      listProjectIssues: async () => {
        throw new Error(
          'Linear: failed to load project "proj_1": network timeout',
        );
      },
      getIssue: async () => fakeIssue,
    };
    const client = await connectedClient(issueTracker);

    const result = await client.callTool({
      name: "linear_list_project_issues",
      arguments: { projectId: "proj_1" },
    });

    expect(result.isError).toBe(true);
    const [block] = result.content as Array<{ type: string; text: string }>;
    expect(block?.text).toContain("network timeout");

    await client.close();
  });

  it("reports a missing required input field as an isError result, not a thrown protocol error", async () => {
    // The SDK validates against the Zod inputSchema before our handler ever
    // runs, and surfaces a failure through the same isError channel as any
    // other tool failure — not a rejected callTool() promise. Our
    // McpLinearIssueTracker adapter's isError handling therefore also
    // covers input-validation failures, with no special-casing needed.
    const issueTracker: IssueTracker = {
      listProjectIssues: async () => fakeProjectIssues,
      getIssue: async () => fakeIssue,
    };
    const client = await connectedClient(issueTracker);

    const result = await client.callTool({
      name: "linear_get_issue",
      arguments: {},
    });

    expect(result.isError).toBe(true);
    const [block] = result.content as Array<{ type: string; text: string }>;
    expect(block?.text).toContain("issueId");

    await client.close();
  });
});
