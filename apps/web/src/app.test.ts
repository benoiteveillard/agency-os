import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { investigate } from "@agency-os/agent";
import type { ProductionRuntime } from "@agency-os/runtime";
import {
  computeApprovalDigest,
  type AuditLogEntry,
  type InvestigationResult,
  type ProposedAction,
} from "@agency-os/shared";
import { createWebApp } from "./app.js";
import { ProposalStore } from "./proposal-store.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function action(id = "proposal-1"): ProposedAction {
  const args = {
    id: "issue-1",
    teamId: "team-1",
    projectId: "project-1",
    title: "Fix launch",
    description: "Fix the blocker",
    priority: 1,
  };
  return {
    id,
    kind: "linear_create_issue",
    args,
    rationale: "Launch is blocked",
    evidenceIds: [],
    targetProjectName: "Acme",
    proposedAt: new Date().toISOString(),
    approvalDigest: computeApprovalDigest("linear_create_issue", args),
  };
}
function result(proposedAction?: ProposedAction): InvestigationResult {
  return {
    answer: "Launch is blocked",
    evidence: [],
    trace: [],
    ...(proposedAction ? { proposedAction } : {}),
  };
}
function runtime() {
  const createIssue = vi.fn(async () => ({ issueId: "issue-1" }));
  const getIssue = vi.fn(async () => ({
    id: "issue-1",
    identifier: "ACME-1",
    title: "Fix launch",
    url: "https://linear.app/acme/issue/ACME-1",
  }));
  const close = vi.fn(async () => {});
  const value = {
    dependencies: { issueTracker: { getIssue }, projectRegistry: {} },
    anthropicApiKey: "private-api-key",
    issueWriter: { createIssue },
    close,
  } as unknown as ProductionRuntime;
  return { value, createIssue, getIssue, close };
}
function post(path: string, value: unknown) {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  });
}
function parseEvents(text: string) {
  return text
    .split("\n\n")
    .filter((block) => block.includes("event:"))
    .map((block) => {
      const event = block.match(/^event: (.*)$/m)?.[1];
      const raw = block.match(/^data: (.*)$/m)?.[1];
      return {
        event,
        data: JSON.parse(raw ?? "null") as Record<string, unknown>,
      };
    });
}
function setup(proposal = action(), store = new ProposalStore()) {
  const rt = runtime();
  const factory = vi.fn(async () => rt.value);
  const run = vi.fn<typeof investigate>().mockResolvedValue(result(proposal));
  const app = createWebApp({
    createRuntime: factory,
    investigate: run,
    store,
    pollMs: 1,
  });
  return { rt, factory, run, app, store };
}
const decide = (id: string, decision: string) =>
  post(`/api/proposals/${id}/decide`, { decision });

const originalWriteMode = process.env.DEMO_WRITE_MODE;
afterEach(() => {
  if (originalWriteMode === undefined) delete process.env.DEMO_WRITE_MODE;
  else process.env.DEMO_WRITE_MODE = originalWriteMode;
});

describe("HTTP validation", () => {
  it("exposes health without initializing runtime", async () => {
    const { app, factory } = setup();
    expect(await (await app.request("/health")).json()).toEqual({
      status: "ok",
    });
    expect(factory).not.toHaveBeenCalled();
  });
  it.each([
    {},
    [],
    null,
    { question: "" },
    { question: "  " },
    { question: 4 },
    { question: "x".repeat(8001) },
    { question: "valid", args: {} },
  ])("rejects malformed investigation %j", async (value) => {
    const { app, factory } = setup();
    const response = await app.request(post("/api/investigate", value));
    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(factory).not.toHaveBeenCalled();
  });
  it("rejects invalid JSON, non-JSON, oversized bodies and cross-origin requests", async () => {
    const { app, factory } = setup();
    for (const [headers, body, status] of [
      [{ "content-type": "application/json" }, "{", 400],
      [{ "content-type": "text/plain" }, '{"question":"q"}', 400],
      [
        { "content-type": "application/json" },
        JSON.stringify({ question: "x".repeat(33000) }),
        413,
      ],
      [
        { "content-type": "application/json", origin: "https://evil.example" },
        '{"question":"q"}',
        403,
      ],
      [
        { "content-type": "application/json", "sec-fetch-site": "cross-site" },
        '{"question":"q"}',
        403,
      ],
    ] as const) {
      expect(
        (
          await app.request(
            new Request("http://localhost/api/investigate", {
              method: "POST",
              headers,
              body,
            }),
          )
        ).status,
      ).toBe(status);
    }
    expect(factory).not.toHaveBeenCalled();
  });
  it("accepts a same-origin request behind a TLS-terminating proxy (X-Forwarded-Proto https, raw connection http)", async () => {
    // Reproduces the real Railway production bug: the browser's Origin is
    // genuinely https, but this process only ever sees the proxy's plain-
    // http connection — the check must trust X-Forwarded-Proto for the
    // scheme, not c.req.url's own (always-http-here) scheme.
    const { app } = setup();
    const response = await app.request(
      new Request("http://localhost/api/investigate", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://localhost",
          "x-forwarded-proto": "https",
        },
        body: '{"question":"q"}',
      }),
    );
    expect(response.status).not.toBe(403);
  });
  it("still rejects a genuinely cross-origin request even with X-Forwarded-Proto present", async () => {
    const { app, factory } = setup();
    const response = await app.request(
      new Request("http://localhost/api/investigate", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://evil.example",
          "x-forwarded-proto": "https",
        },
        body: '{"question":"q"}',
      }),
    );
    expect(response.status).toBe(403);
    expect(factory).not.toHaveBeenCalled();
  });
  it.each([
    { decision: "yes" },
    { decision: "approve", args: { title: "tampered" } },
    { decision: "reject", approvalDigest: "client-digest" },
  ])("rejects untrusted decision payload %j", async (value) => {
    const { app, factory } = setup();
    expect(
      (await app.request(post("/api/proposals/proposal-1/decide", value)))
        .status,
    ).toBe(400);
    expect(factory).not.toHaveBeenCalled();
  });
});

describe("investigation transport", () => {
  it("streams the answer text, coalesced, in order with resets", async () => {
    const rt = runtime();
    const run = vi
      .fn<typeof investigate>()
      .mockImplementation(async (_q, _deps, options) => {
        options!.onAnswerText!({ type: "reset" });
        options!.onAnswerText!({ type: "delta", text: "Checking " });
        options!.onAnswerText!({ type: "delta", text: "Slack." });
        await new Promise((resolve) => setTimeout(resolve, 20));
        options!.onAnswerText!({ type: "reset" });
        options!.onAnswerText!({ type: "delta", text: "Launch is blocked" });
        return result();
      });
    const app = createWebApp({
      createRuntime: async () => rt.value,
      investigate: run,
      pollMs: 1,
    });

    const response = await app.request(
      post("/api/investigate", { question: "Investigate" }),
    );
    const events = parseEvents(await response.text()).filter((e) =>
      e.event?.startsWith("answer."),
    );

    expect(events).toEqual([
      { event: "answer.reset", data: {} },
      { event: "answer.delta", data: { text: "Checking Slack." } },
      { event: "answer.reset", data: {} },
      { event: "answer.delta", data: { text: "Launch is blocked" } },
    ]);
  });

  it("streams live curated activity before investigation resolves", async () => {
    const gate = deferred<InvestigationResult>();
    const rt = runtime();
    const run = vi
      .fn<typeof investigate>()
      .mockImplementation(async (_q, _deps, options) => {
        const span = options!.tracer!.startSpan(
          "tool.slack_get_thread",
          "tool",
          {
            parent: options!.parentSpan,
            attributes: { body: "PRIVATE SLACK BODY", input: "SECRET PROMPT" },
          },
        );
        const response = await gate.promise;
        span.end("ok");
        return response;
      });
    const app = createWebApp({
      createRuntime: async () => rt.value,
      investigate: run,
      pollMs: 1,
    });
    const response = await app.request(
      post("/api/investigate", { question: "  Investigate  " }),
    );
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    const reader = response.body!.getReader();
    let text = "";
    while (!text.includes("source.started"))
      text += new TextDecoder().decode((await reader.read()).value);
    expect(text).toContain("investigation.started");
    expect(text).not.toContain("investigation.completed");
    expect(text).not.toMatch(/PRIVATE|SECRET|private-api-key/);
    expect(rt.close).not.toHaveBeenCalled();
    gate.resolve(result());
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += new TextDecoder().decode(chunk.value);
    }
    const events = parseEvents(text);
    expect(events.map((e) => e.event)).toEqual([
      "investigation.started",
      "source.started",
      "source.completed",
      "investigation.completed",
    ]);
    expect(run.mock.calls[0]?.[0]).toBe("Investigate");
    expect(rt.close).toHaveBeenCalledTimes(1);
  });
  it("returns a sanitized failure and always cleans up", async () => {
    const { app, run, rt } = setup();
    run.mockRejectedValue(new Error("token=secret provider payload"));
    const text = await (
      await app.request(post("/api/investigate", { question: "q" }))
    ).text();
    expect(text).toContain("investigation.failed");
    expect(text).not.toMatch(/secret|provider payload|investigation.completed/);
    expect(rt.close).toHaveBeenCalledTimes(1);
  });
  it("isolates simultaneous investigations and their trace IDs", async () => {
    const runtimes = [runtime(), runtime()];
    const factory = vi
      .fn()
      .mockResolvedValueOnce(runtimes[0]!.value)
      .mockResolvedValueOnce(runtimes[1]!.value);
    const gates = [
      deferred<InvestigationResult>(),
      deferred<InvestigationResult>(),
    ];
    const run = vi
      .fn<typeof investigate>()
      .mockImplementationOnce(() => gates[0]!.promise)
      .mockImplementationOnce(() => gates[1]!.promise);
    const app = createWebApp({
      createRuntime: factory,
      investigate: run,
      pollMs: 1,
      // This test is about trace isolation between concurrent runs, not
      // the Phase 7.4 concurrency cap (default 1) — needs headroom for 2.
      maxConcurrentInvestigations: 2,
    });
    const responses = await Promise.all([
      app.request(post("/api/investigate", { question: "a" })),
      app.request(post("/api/investigate", { question: "b" })),
    ]);
    gates[1]!.resolve({ ...result(), answer: "answer B" });
    gates[0]!.resolve({ ...result(), answer: "answer A" });
    const streams = await Promise.all(responses.map((r) => r.text()));
    expect(streams[0]).toContain("answer A");
    expect(streams[0]).not.toContain("answer B");
    expect(streams[1]).toContain("answer B");
    expect(parseEvents(streams[0]!)[0]!.data.traceId).not.toBe(
      parseEvents(streams[1]!)[0]!.data.traceId,
    );
    runtimes.forEach((rt) => expect(rt.close).toHaveBeenCalledTimes(1));
  });
  it("cancels the run when the client disconnects, keeps no proposal and frees the slot", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { app, run, rt } = setup();
    let signal: AbortSignal | undefined;
    const gate = deferred<InvestigationResult>();
    run.mockImplementation(async (_q, _deps, options) => {
      signal = options.signal;
      return gate.promise;
    });
    const response = await app.request(
      post("/api/investigate", { question: "q" }),
    );
    const reader = response.body!.getReader();
    await vi.waitFor(() => expect(signal).toBeDefined());
    await reader.read();
    await reader.cancel();

    await vi.waitFor(() => expect(signal!.aborted).toBe(true));
    gate.resolve(result(action()));
    await vi.waitFor(() => expect(rt.close).toHaveBeenCalledTimes(1));

    expect((await app.request(decide("proposal-1", "reject"))).status).toBe(
      404,
    );
    const next = await app.request(post("/api/investigate", { question: "b" }));
    expect(next.status).toBe(200);
    await next.text();
    expect(
      log.mock.calls.some(([line]) =>
        String(line).includes("investigation.cancelled"),
      ),
    ).toBe(true);
    log.mockRestore();
  });
  it("fails a run that exceeds its deadline, frees the slot and cleans up", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const rt = runtime();
    const run = vi
      .fn<typeof investigate>()
      .mockImplementationOnce(
        (_q, _deps, options) =>
          new Promise((_resolve, reject) => {
            options.signal!.addEventListener("abort", () =>
              reject(options.signal!.reason),
            );
          }),
      )
      .mockResolvedValue(result());
    const app = createWebApp({
      createRuntime: async () => rt.value,
      investigate: run,
      pollMs: 1,
      investigationTimeoutMs: 5,
    });
    const text = await (
      await app.request(post("/api/investigate", { question: "q" }))
    ).text();

    expect(text).toContain("investigation.failed");
    expect(rt.close).toHaveBeenCalledTimes(1);
    const line = log.mock.calls
      .map(([value]) => String(value))
      .find((value) => value.includes('"investigation.failed"'));
    expect(line).toContain('"category":"timeout"');
    const next = await app.request(post("/api/investigate", { question: "b" }));
    expect(next.status).toBe(200);
    await next.text();
    log.mockRestore();
  });
  it("closes a runtime that finishes starting after the run was cancelled", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const rt = runtime();
    const slowStart = deferred<ProductionRuntime>();
    const app = createWebApp({
      createRuntime: () => slowStart.promise,
      investigate: vi.fn<typeof investigate>(),
      pollMs: 1,
      investigationTimeoutMs: 5,
    });
    const text = await (
      await app.request(post("/api/investigate", { question: "q" }))
    ).text();
    expect(text).toContain("investigation.failed");

    slowStart.resolve(rt.value);
    await vi.waitFor(() => expect(rt.close).toHaveBeenCalledTimes(1));
    log.mockRestore();
  });
});

describe("concurrency cap (Phase 7.4 public-demo abuse protection)", () => {
  it("rejects an excess concurrent investigation with 429 demo_busy, no SSE stream, no model call", async () => {
    const gate = deferred<InvestigationResult>();
    const run = vi.fn<typeof investigate>().mockReturnValue(gate.promise);
    const app = createWebApp({
      createRuntime: async () => runtime().value,
      investigate: run,
      pollMs: 1,
      maxConcurrentInvestigations: 1,
    });

    const first = app.request(post("/api/investigate", { question: "a" }));
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));

    const second = await app.request(
      post("/api/investigate", { question: "b" }),
    );

    expect(second.status).toBe(429);
    expect(second.headers.get("content-type")).toContain("application/json");
    expect(await second.json()).toEqual({
      error: { code: "demo_busy", message: expect.any(String) },
    });
    expect(run).toHaveBeenCalledTimes(1); // the excess request never reached investigate()

    gate.resolve(result());
    expect((await first).status).toBe(200);
  });

  it("accepts a new investigation once the previous one has finished", async () => {
    const { app, run } = setup();
    run.mockResolvedValue(result());

    // Drain the full stream so the counter's finally() has actually run —
    // app.request() alone only resolves once headers are ready, not once
    // the SSE body (and its cleanup) has finished.
    await (
      await app.request(post("/api/investigate", { question: "a" }))
    ).text();
    const secondResponse = await app.request(
      post("/api/investigate", { question: "b" }),
    );
    expect(secondResponse.status).toBe(200);
    await secondResponse.text();

    expect(run).toHaveBeenCalledTimes(2);
  });
});

describe("concurrency cap configuration", () => {
  const original = process.env.MAX_CONCURRENT_INVESTIGATIONS;
  afterEach(() => {
    if (original === undefined)
      delete process.env.MAX_CONCURRENT_INVESTIGATIONS;
    else process.env.MAX_CONCURRENT_INVESTIGATIONS = original;
  });

  it.each(["abc", "", "0", "-1", "1.5"])(
    "refuses to start with MAX_CONCURRENT_INVESTIGATIONS=%j rather than removing the cap",
    (value) => {
      process.env.MAX_CONCURRENT_INVESTIGATIONS = value;
      expect(() => createWebApp()).toThrow(/MAX_CONCURRENT_INVESTIGATIONS/);
    },
  );

  it("defaults to 1 when unset", () => {
    delete process.env.MAX_CONCURRENT_INVESTIGATIONS;
    expect(() => createWebApp()).not.toThrow();
  });
});

describe("DEMO_WRITE_MODE (public-demo write policy)", () => {
  it.each([undefined, "disabled", "true", "Enabled", ""])(
    "records approval honestly but never writes or starts a runtime when set to %j",
    async (value) => {
      if (value === undefined) delete process.env.DEMO_WRITE_MODE;
      else process.env.DEMO_WRITE_MODE = value;
      const { app, store, rt, factory } = setup();
      store.insert(action(), "trace-original");

      const response = await app.request(decide("proposal-1", "approve"));

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        decision: "approved",
        execution: { outcome: "execution_disabled" },
      });
      expect(rt.createIssue).not.toHaveBeenCalled();
      expect(factory).not.toHaveBeenCalled();
    },
  );

  it("records approval honestly but never calls the real issueWriter", async () => {
    process.env.DEMO_WRITE_MODE = "disabled";
    const { app, store, rt } = setup();
    store.insert(action(), "trace-original");

    const response = await app.request(decide("proposal-1", "approve"));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      decision: "approved",
      execution: { outcome: "execution_disabled" },
    });
    expect(rt.createIssue).not.toHaveBeenCalled();
    expect(rt.getIssue).not.toHaveBeenCalled();
  });

  it("still rejects normally — only the approve+write path is affected", async () => {
    process.env.DEMO_WRITE_MODE = "disabled";
    const { app, store, rt } = setup();
    store.insert(action(), "trace-original");

    const response = await app.request(decide("proposal-1", "reject"));

    expect(await response.json()).toMatchObject({ decision: "rejected" });
    expect(rt.createIssue).not.toHaveBeenCalled();
  });

  it("writes only with the exact value 'enabled'", async () => {
    process.env.DEMO_WRITE_MODE = "enabled";
    const { app, store, rt } = setup();
    store.insert(action(), "trace-original");

    const response = await app.request(decide("proposal-1", "approve"));

    expect(await response.json()).toMatchObject({
      execution: { outcome: "success" },
    });
    expect(rt.createIssue).toHaveBeenCalledOnce();
  });
});

describe("approval HTTP boundary using real reviewAndExecute", () => {
  beforeEach(() => {
    process.env.DEMO_WRITE_MODE = "enabled";
  });

  it("stores a canonical proposal and executes only its exact approved arguments", async () => {
    const { app, rt } = setup();
    const text = await (
      await app.request(post("/api/investigate", { question: "q" }))
    ).text();
    expect(text).toContain("action.proposed");
    expect(text).not.toContain("approvalDigest");
    const first = await app.request(decide("proposal-1", "approve"));
    const audit = await first.json();
    expect(first.status).toBe(200);
    expect(audit).toMatchObject({ execution: { outcome: "success" } });
    expect(rt.createIssue).toHaveBeenCalledExactlyOnceWith(action().args);
    const retry = await app.request(decide("proposal-1", "approve"));
    expect(await retry.json()).toEqual(audit);
    expect(rt.createIssue).toHaveBeenCalledTimes(1);
    expect((await app.request(decide("proposal-1", "reject"))).status).toBe(
      409,
    );
  });
  it("rejects without writing, with repeat rejection idempotent", async () => {
    const { app, store, rt } = setup();
    store.insert(action(), "trace-original");
    const response = await app.request(decide("proposal-1", "reject"));
    expect(await response.json()).toMatchObject({ decision: "rejected" });
    expect((await app.request(decide("proposal-1", "reject"))).status).toBe(
      200,
    );
    expect(rt.createIssue).not.toHaveBeenCalled();
    expect(rt.getIssue).not.toHaveBeenCalled();
  });
  it("records the decision before writing, then the result", async () => {
    const order: string[] = [];
    const rt = runtime();
    rt.createIssue.mockImplementation(async () => {
      order.push("write");
      return { issueId: "issue-1" };
    });
    const append = vi.fn(async (entry: AuditLogEntry) => {
      order.push(entry.event);
    });
    const store = new ProposalStore();
    store.insert(action(), "trace-original");
    const app = createWebApp({
      createRuntime: async () => rt.value,
      store,
      auditLog: { append },
    });

    expect((await app.request(decide("proposal-1", "approve"))).status).toBe(
      200,
    );

    expect(order).toEqual(["decision", "write", "result"]);
    expect(append.mock.calls[0]![0]).toMatchObject({
      event: "decision",
      decision: "approve",
      actor: "anonymous web visitor",
      investigationTraceId: "trace-original",
      proposal: { id: "proposal-1", rationale: "Launch is blocked" },
    });
    expect(append.mock.calls[1]![0]).toMatchObject({
      event: "result",
      audit: { decision: "approved", execution: { outcome: "success" } },
    });
  });
  it("records rejections too", async () => {
    const append = vi.fn(async () => {});
    const store = new ProposalStore();
    store.insert(action(), "trace-original");
    const app = createWebApp({ store, auditLog: { append } });
    await app.request(decide("proposal-1", "reject"));
    expect(append).toHaveBeenCalledTimes(2);
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({ event: "decision", decision: "reject" }),
    );
  });
  it("refuses to write when the decision can't be recorded", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const rt = runtime();
    const store = new ProposalStore();
    store.insert(action(), "trace-original");
    const app = createWebApp({
      createRuntime: async () => rt.value,
      store,
      auditLog: {
        append: async () => {
          throw new Error("disk full");
        },
      },
    });

    expect((await app.request(decide("proposal-1", "approve"))).status).toBe(
      502,
    );
    expect(rt.createIssue).not.toHaveBeenCalled();
    expect(rt.close).toHaveBeenCalledTimes(1);
    log.mockRestore();
  });
  it("still reports the outcome when only the result can't be recorded", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const rt = runtime();
    const store = new ProposalStore();
    store.insert(action(), "trace-original");
    const append = vi
      .fn<(entry: AuditLogEntry) => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("disk full"));
    const app = createWebApp({
      createRuntime: async () => rt.value,
      store,
      auditLog: { append },
    });

    const response = await app.request(decide("proposal-1", "approve"));

    expect(response.status).toBe(200);
    expect(rt.createIssue).toHaveBeenCalledOnce();
    expect(log.mock.calls.join()).toContain("audit.result_write_failed");
    log.mockRestore();
  });
  it("gives the trace its question, answer and outcome", async () => {
    const onTrace = vi.fn(async () => {});
    const rt = runtime();
    const app = createWebApp({
      createRuntime: async () => rt.value,
      investigate: vi.fn<typeof investigate>().mockResolvedValue(result()),
      onTrace,
      pollMs: 1,
    });
    await (
      await app.request(post("/api/investigate", { question: "  Why?  " }))
    ).text();
    await vi.waitFor(() => expect(onTrace).toHaveBeenCalledOnce());
    expect(onTrace.mock.calls[0]!).toMatchObject([
      expect.any(Array),
      {
        question: "Why?",
        finalAnswer: "Launch is blocked",
        resultMetadata: { evidenceCount: 0, proposedAction: false },
      },
    ]);
  });
  it("rejects even when the runtime can't start, since a rejection needs none", async () => {
    const { app, store, factory } = setup();
    store.insert(action(), "trace-original");
    factory.mockRejectedValue(new Error("Missing LINEAR_API_KEY"));
    const response = await app.request(decide("proposal-1", "reject"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ decision: "rejected" });
    expect(factory).not.toHaveBeenCalled();
  });
  it("logs a failed decision once, while keeping the cause out of the response", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { app, store, factory } = setup();
    store.insert(action(), "trace-original");
    factory.mockRejectedValue(new Error("MCP process failed to start"));

    const first = await app.request(decide("proposal-1", "approve"));
    await app.request(decide("proposal-1", "approve"));

    expect(await first.text()).not.toContain("MCP process");
    const logged = log.mock.calls
      .map(([line]) => String(line))
      .filter((line) => line.includes("proposal.decision_failed"));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("MCP process failed to start");
    log.mockRestore();
  });
  it("locks concurrent approvals before the first external write finishes", async () => {
    const { app, store, rt } = setup();
    store.insert(action(), "trace-original");
    const gate = deferred<{ issueId: string }>();
    rt.createIssue.mockReturnValue(gate.promise);
    const first = app.request(decide("proposal-1", "approve"));
    await vi.waitFor(() => expect(rt.createIssue).toHaveBeenCalledTimes(1));
    const second = await app.request(decide("proposal-1", "approve"));
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({
      error: { code: "proposal_in_progress" },
    });
    gate.resolve({ issueId: "issue-1" });
    expect((await first).status).toBe(200);
    expect((await app.request(decide("proposal-1", "approve"))).status).toBe(
      200,
    );
    expect(rt.createIssue).toHaveBeenCalledTimes(1);
  });
  it("never retries failed writes or exposes provider errors", async () => {
    const { app, store, rt } = setup();
    store.insert(action(), "trace-original");
    rt.createIssue.mockRejectedValue(new Error("PRIVATE token provider error"));
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await app.request(decide("proposal-1", "approve"));
      expect(response.status).toBe(502);
      expect(await response.text()).not.toMatch(/PRIVATE|token|provider error/);
    }
    expect(rt.createIssue).toHaveBeenCalledTimes(1);
  });
  it("reports executed_unconfirmed when write succeeds but read-back fails", async () => {
    const { app, store, rt } = setup();
    store.insert(action(), "trace-original");
    rt.getIssue.mockRejectedValue(new Error("PRIVATE read response"));
    const response = await app.request(decide("proposal-1", "approve"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      execution: { outcome: "executed_unconfirmed" },
    });
    await app.request(decide("proposal-1", "approve"));
    expect(rt.createIssue).toHaveBeenCalledTimes(1);
  });
  it("fails closed when the runtime never finishes starting", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const store = new ProposalStore();
    store.insert(action(), "trace-original");
    const app = createWebApp({
      createRuntime: () => new Promise<never>(() => {}),
      store,
      runtimeStartTimeoutMs: 5,
    });
    expect((await app.request(decide("proposal-1", "approve"))).status).toBe(
      502,
    );
    log.mockRestore();
  });
  it("fails closed after runtime construction failure", async () => {
    const { app, store, factory } = setup();
    store.insert(action(), "trace-original");
    factory.mockRejectedValue(new Error("PRIVATE failure"));
    expect((await app.request(decide("proposal-1", "approve"))).status).toBe(
      502,
    );
    expect((await app.request(decide("proposal-1", "approve"))).status).toBe(
      502,
    );
    expect(factory).toHaveBeenCalledTimes(1);
  });
  it("refuses unknown and expired proposals without creating runtime", async () => {
    let now = 0;
    const store = new ProposalStore({ now: () => now, ttlMs: 10 });
    const { app, factory } = setup(action(), store);
    store.insert(action(), "trace-original");
    expect((await app.request(decide("unknown", "approve"))).status).toBe(404);
    now = 11;
    expect((await app.request(decide("proposal-1", "approve"))).status).toBe(
      410,
    );
    expect(factory).not.toHaveBeenCalled();
  });
});
