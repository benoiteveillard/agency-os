import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import type { ProductionRuntime } from "@agency-os/runtime";
import { expect, it, vi } from "vitest";
import { createWebApp } from "./app.js";

it("streams through the actual Node adapter before investigation resolves", async () => {
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const close = vi.fn(async () => {});
  const app = createWebApp({
    createRuntime: async () => ({
      anthropicApiKey: "fake",
      dependencies: {} as ProductionRuntime["dependencies"],
      issueWriter: {
        createIssue: async () => {
          throw new Error("No writes in transport test");
        },
      },
      close,
    }),
    investigate: async (_question, _deps, { tracer }) => {
      const span = tracer.startSpan("tool.linear_list_project_issues", "tool");
      await gate;
      span.end("ok");
      return { answer: "Complete", evidence: [], trace: [] };
    },
    pollMs: 1,
  });
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  try {
    if (!server.listening) await once(server, "listening");
    const address = server.address() as AddressInfo;
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/investigate`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: "Test" }),
      },
    );
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (!text.includes("source.started")) {
      const part = await reader.read();
      expect(part.done).toBe(false);
      text += decoder.decode(part.value);
    }
    expect(text).toContain("investigation.started");
    expect(text).not.toContain("investigation.completed");
    finish();
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      text += decoder.decode(part.value);
    }
    expect(text).toContain("source.completed");
    expect(text).toContain("investigation.completed");
    expect(close).toHaveBeenCalledOnce();
  } finally {
    finish();
    if ("closeAllConnections" in server) server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
