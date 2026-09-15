import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/**/src/**/*.test.ts",
      "apps/**/src/**/*.test.ts",
      "apps/**/src/**/*.test.tsx",
      "mcp/**/src/**/*.test.ts",
    ],
    // Only *.test.tsx files opt into jsdom via a per-file
    // `// @vitest-environment jsdom` docblock; this setup (jest-dom
    // matchers) is inert for Node-environment tests, so it's safe to load
    // globally rather than duplicating an environmentMatchGlobs config.
    setupFiles: ["apps/web/client/src/test-setup.ts"],
  },
});
