import { describe, expect, it } from "vitest";
import { categorizeError, truncate, truncateErrorMessage } from "./redact.js";

describe("truncate", () => {
  it("leaves short strings untouched", () => {
    expect(truncate("hello", 80)).toBe("hello");
  });

  it("truncates and marks long strings", () => {
    const long = "x".repeat(100);
    const result = truncate(long, 80);
    expect(result).toHaveLength(81); // 80 chars + ellipsis
    expect(result.endsWith("…")).toBe(true);
  });
});

describe("truncateErrorMessage", () => {
  it("caps at 200 characters regardless of source", () => {
    const long = "y".repeat(500);
    expect(truncateErrorMessage(long).length).toBeLessThanOrEqual(201);
  });
});

describe("categorizeError", () => {
  it("recognizes MCP transport failures", () => {
    expect(
      categorizeError('Linear MCP tool "linear_get_issue" failed: timeout'),
    ).toBe("mcp_transport");
  });

  it("recognizes digest mismatch failures", () => {
    expect(
      categorizeError(
        "Approval digest mismatch for proposal x: the action changed",
      ),
    ).toBe("digest_mismatch");
  });

  it("recognizes SaaS API failures by integration prefix", () => {
    expect(
      categorizeError('Linear: failed to load project "x": network timeout'),
    ).toBe("saas_api");
    expect(categorizeError("GitHub: failed to list pull requests: 500")).toBe(
      "saas_api",
    );
    expect(
      categorizeError("Slack: failed to load channel messages: rate limited"),
    ).toBe("saas_api");
  });

  it("recognizes tool validation failures", () => {
    expect(
      categorizeError('Tool input missing required string field "title"'),
    ).toBe("tool_validation");
    expect(
      categorizeError('Unknown project slug "nope". Known slugs: acme'),
    ).toBe("tool_validation");
  });

  it("falls back to unknown for anything else", () => {
    expect(categorizeError("something unexpected happened")).toBe("unknown");
  });
});
