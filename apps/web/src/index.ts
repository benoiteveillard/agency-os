import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { readFile } from "node:fs/promises";
import { serializeTraceFile } from "@agency-os/observability";
import { exportTrace } from "@agency-os/observability-otel-export";
import { createWebApp } from "./app.js";

// src/index.ts and dist/server.js have the same depth relative to the repository.
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
// `client/` sits next to this file both in dev (src/) and in the esbuild
// bundle (dist/server.js) — produced by `vite build` (see package.json's
// build:client script), never committed.
const clientDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "client",
);
config({ path: path.join(repoRoot, ".env"), quiet: true });
const port = Number(process.env.PORT ?? "3000");
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("Invalid PORT");
const app = createWebApp({
  onTrace: async (spans) => {
    const traceId = spans[0]?.traceId;
    if (!traceId) return;
    try {
      const directory = path.join(repoRoot, ".traces");
      await mkdir(directory, { recursive: true });
      await writeFile(
        path.join(directory, `${traceId}.jsonl`),
        serializeTraceFile(spans, {
          traceId,
          question: "",
          finalAnswer: "",
          resultMetadata: {},
        }),
      );
    } catch {
      console.error(
        JSON.stringify({ event: "trace.persistence_failed", traceId }),
      );
    }
    const result = await exportTrace(spans);
    console.error(
      JSON.stringify({
        event: "trace.export",
        traceId,
        attempted: result.attempted,
        ok: result.ok,
      }),
    );
  },
});

// Production only: dev serves the frontend from Vite's own dev server
// (apps/web/vite.config.ts proxies /api and /health here). Registered
// after the API routes so /api/* and /health still take precedence.
if (existsSync(clientDir)) {
  app.use("/*", serveStatic({ root: clientDir }));
  const indexHtml = await readFile(path.join(clientDir, "index.html"), "utf-8");
  app.get("*", (c) => c.html(indexHtml));
}

const server = serve(
  { fetch: app.fetch, hostname: process.env.HOST ?? "127.0.0.1", port },
  (info) => {
    console.error(`Web runtime listening on port ${info.port}`);
  },
);
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    server.close();
  });
}
