import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Mirrors packages/agent/src/dependency-boundary.test.ts: eval-runner never
 * gets a real write-capable Linear client either — fixture mode uses
 * FixtureIssueWriter, live mode uses RefusingIssueWriter, and neither
 * depends on @agency-os/integration-linear-writer. If this ever changes,
 * this test fails immediately regardless of whether anything calls it yet.
 */
describe("apps/eval-runner dependency boundary", () => {
  it("never depends on the write-capable Linear integration", () => {
    const packageJsonPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../package.json",
    );
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as {
      dependencies?: Record<string, string>;
    };

    expect(Object.keys(packageJson.dependencies ?? {})).not.toContain(
      "@agency-os/integration-linear-writer",
    );
  });
});
