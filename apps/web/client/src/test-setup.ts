import { afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";

// Only meaningful for *.test.tsx files running under the jsdom environment
// (per-file `// @vitest-environment jsdom` pragma) — `document` is
// undefined for the rest of the monorepo's plain Node test files, which
// load this same global setupFiles entry.
if (typeof document !== "undefined") {
  const { cleanup } = await import("@testing-library/react");
  afterEach(cleanup);
}
