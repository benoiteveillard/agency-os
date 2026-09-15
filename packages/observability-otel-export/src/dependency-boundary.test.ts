import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * packages/observability is zero-dependency by design (Phase 4) — it must
 * never learn about OTLP, Cloudflare, or any other export destination.
 * This new package is the only place that dependency direction is allowed
 * to point: observability-otel-export -> observability, never the
 * reverse. If a future change ever adds an @opentelemetry/* or exporter
 * dependency to packages/observability itself, this fails immediately.
 */
describe("packages/observability independence", () => {
  it("packages/observability has zero dependencies", () => {
    const packageJsonPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../observability/package.json",
    );
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as {
      dependencies?: Record<string, string>;
    };

    expect(packageJson.dependencies ?? {}).toEqual({});
  });

  it("this package depends on packages/observability, not the other way around", () => {
    const packageJsonPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../package.json",
    );
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as {
      dependencies?: Record<string, string>;
    };

    expect(Object.keys(packageJson.dependencies ?? {})).toContain(
      "@agency-os/observability",
    );
  });
});
