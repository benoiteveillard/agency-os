import { describe, expect, it } from "vitest";
import { toolCallAttributes } from "./trace-attributes.js";
import { TOOLS } from "./tools.js";

describe("toolCallAttributes", () => {
  it("emits exactly the approved identifier for each read tool", () => {
    expect(
      toolCallAttributes("linear_list_project_issues", {
        projectSlug: "acme-website-migration",
      }),
    ).toEqual({ projectSlug: "acme-website-migration" });

    expect(
      toolCallAttributes("github_list_pull_requests", {
        projectSlug: "acme-website-migration",
      }),
    ).toEqual({ projectSlug: "acme-website-migration" });

    expect(
      toolCallAttributes("github_get_workflow_run_status", {
        projectSlug: "acme-website-migration",
        ref: "e08a877abc123",
      }),
    ).toEqual({
      projectSlug: "acme-website-migration",
      ref: "e08a877abc123",
    });

    expect(
      toolCallAttributes("slack_get_channel_messages", {
        projectSlug: "acme-website-migration",
      }),
    ).toEqual({ projectSlug: "acme-website-migration" });

    expect(
      toolCallAttributes("slack_get_thread", {
        projectSlug: "acme-website-migration",
        threadTs: "1789216535.098929",
      }),
    ).toEqual({
      projectSlug: "acme-website-migration",
      threadTs: "1789216535.098929",
    });
  });

  it("emits nothing at all for propose_linear_issue, even though its input has fields", () => {
    expect(
      toolCallAttributes("propose_linear_issue", {
        projectSlug: "acme-website-migration",
        title: "Fix Safari nav bug",
        description: "Long markdown body citing Slack quotes...",
        rationale: "Because X blocks Y",
        priority: "high",
      }),
    ).toEqual({});
  });

  it("drops fields not on that tool's whitelist, even if present in input", () => {
    expect(
      toolCallAttributes("linear_list_project_issues", {
        projectSlug: "acme-website-migration",
        // Not a real field of this tool's schema, but proves unlisted keys
        // never leak through regardless of what a caller passes.
        title: "should never appear",
      }),
    ).toEqual({ projectSlug: "acme-website-migration" });
  });

  it("drops a whitelisted key if its value isn't a scalar", () => {
    expect(
      toolCallAttributes("slack_get_thread", {
        projectSlug: "acme-website-migration",
        threadTs: { nested: "object" },
      }),
    ).toEqual({ projectSlug: "acme-website-migration" });
  });

  it("returns nothing for an unknown tool name", () => {
    expect(
      toolCallAttributes("some_future_tool", { projectSlug: "x" }),
    ).toEqual({});
  });

  it("never whitelists a content-bearing field of any current tool schema", () => {
    const contentFieldNames = new Set([
      "title",
      "description",
      "rationale",
      "text",
      "body",
    ]);
    for (const tool of TOOLS) {
      const properties = Object.keys(
        (tool.input_schema as { properties?: Record<string, unknown> })
          .properties ?? {},
      );
      const contentFields = properties.filter((p) => contentFieldNames.has(p));
      for (const field of contentFields) {
        const attrs = toolCallAttributes(tool.name, { [field]: "leak-test" });
        expect(attrs).not.toHaveProperty(field);
      }
    }
  });
});
