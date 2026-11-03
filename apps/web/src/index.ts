import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { readFile } from "node:fs/promises";
import { serializeTraceFile } from "@agency-os/observability";
import { createFileAuditLog } from "@agency-os/runtime";
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
// Phase 7.4: the compiled Linear MCP server's path (Phase 7.0's
// LINEAR_MCP_SERVER_ENTRY mechanism, packages/integrations/
// linear-mcp-client/src/create-client.ts) must not be guessed for a given
// deployment platform's filesystem layout — self-compute it the same
// repoRoot-relative way clientDir above already does, so it's correct
// under any mount point (local, Railway, or otherwise) without needing
// platform-specific configuration. Still fully overridable by an
// explicit .env/platform value, since that's set first.
if (!process.env.LINEAR_MCP_SERVER_ENTRY) {
  process.env.LINEAR_MCP_SERVER_ENTRY = path.join(
    repoRoot,
    "mcp/linear/dist/server.js",
  );
}
const port = Number(process.env.PORT ?? "3000");
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("Invalid PORT");
// Traces and the audit log live here. On a host with an ephemeral filesystem,
// point it at a persistent volume, or both are lost on every deploy.
const dataDir = process.env.AGENCY_DATA_DIR ?? repoRoot;
const app = createWebApp({
  auditLog: createFileAuditLog(path.join(dataDir, ".audit/decisions.jsonl")),
  onTrace: async (spans, summary) => {
    const traceId = spans[0]?.traceId;
    if (!traceId) return;
    try {
      const directory = path.join(dataDir, ".traces");
      await mkdir(directory, { recursive: true });
      await writeFile(
        path.join(directory, `${traceId}.jsonl`),
        serializeTraceFile(spans, { traceId, ...summary }),
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
