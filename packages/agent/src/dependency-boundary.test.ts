import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The core safety claim of Phase 3's approval design (docs/decisions.md):
 * the write-capable Linear client is structurally absent from the package
 * the model's tool loop runs in — not merely gated by a runtime check.
 * This test makes that claim CI-enforced rather than only "true by code
 * review": if a future change ever adds @agency-os/integration-linear-writer
 * to this package's dependencies, this fails immediately, regardless of
 * whether anything actually calls it yet.
 */
describe("packages/agent dependency boundary", () => {
  it("never depends on the write-capable Linear package", () => {
    const packageJsonPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "package.json",
    );
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    const allDeps = {
      ...packageJson.dependencies,
      ...packageJson.devDependencies,
    };

    expect(allDeps).not.toHaveProperty("@agency-os/integration-linear-writer");
  });
});
