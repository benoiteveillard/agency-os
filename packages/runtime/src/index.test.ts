import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  close: vi.fn(async () => {}),
  connect: vi.fn(),
  writer: vi.fn(),
}));
vi.mock("@agency-os/integration-linear-mcp-client", () => ({
  createLinearMcpClient: mocks.connect,
  McpLinearIssueTracker: class {},
}));
vi.mock("@agency-os/integration-github", () => ({
  GitHubPullRequestSource: class {},
}));
vi.mock("@agency-os/integration-slack", () => ({
  SlackConversationSource: class {},
}));
vi.mock("@agency-os/integration-linear-writer", () => ({
  LinearIssueWriter: class {
    constructor(key: string) {
      mocks.writer(key);
    }
  },
}));

import { createProductionRuntime } from "./index.js";

describe("production runtime lifecycle and credentials", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.connect.mockResolvedValue({ close: mocks.close });
    mocks.close.mockResolvedValue(undefined);
    for (const name of [
      "ANTHROPIC_API_KEY",
      "LINEAR_API_KEY",
      "GITHUB_TOKEN",
      "SLACK_BOT_TOKEN",
      "LINEAR_API_KEY_WRITE",
      "LINEAR_PROJECT_ID_ACME",
      "LINEAR_TEAM_ID_ACME",
      "SLACK_CHANNEL_ID_ACME",
    ]) {
      vi.stubEnv(name, `test-${name}`);
    }
  });
  afterEach(() => vi.unstubAllEnvs());

  it("validates configuration before spawning a process", async () => {
    vi.stubEnv("LINEAR_PROJECT_ID_ACME", "");
    await expect(createProductionRuntime()).rejects.toThrow(
      "LINEAR_PROJECT_ID_ACME",
    );
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("keeps write credentials outside read dependencies and closes once", async () => {
    const runtime = await createProductionRuntime();
    expect(mocks.connect).toHaveBeenCalledWith({
      linearApiKey: "test-LINEAR_API_KEY",
    });
    expect(mocks.writer).toHaveBeenCalledWith("test-LINEAR_API_KEY_WRITE");
    expect(runtime.dependencies).not.toHaveProperty("issueWriter");
    expect(runtime.dependencies).not.toHaveProperty("anthropicApiKey");
    await Promise.all([runtime.close(), runtime.close()]);
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it("closes the process if construction after connection fails", async () => {
    mocks.writer.mockImplementation(() => {
      throw new Error("construction failed");
    });
    await expect(createProductionRuntime()).rejects.toThrow(
      "construction failed",
    );
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });
});
