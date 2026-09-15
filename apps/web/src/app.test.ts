import { describe, expect, it, vi } from "vitest";
import type { investigate } from "@agency-os/agent";
import type { ProductionRuntime } from "@agency-os/runtime";
import {
  computeApprovalDigest,
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
  it("finishes disconnected work, stores its proposal and closes its runtime", async () => {
    const { app, run, rt } = setup();
    const gate = deferred<InvestigationResult>();
    run.mockReturnValue(gate.promise);
    const response = await app.request(
      post("/api/investigate", { question: "q" }),
    );
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    gate.resolve(result(action()));
    await vi.waitFor(() => expect(rt.close).toHaveBeenCalledTimes(1));
    expect((await app.request(decide("proposal-1", "reject"))).status).toBe(
      200,
    );
    expect(rt.createIssue).not.toHaveBeenCalled();
  });
});

describe("approval HTTP boundary using real reviewAndExecute", () => {
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
    expect(rt.close).toHaveBeenCalledTimes(1);
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
