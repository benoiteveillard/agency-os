import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError, decideProposal, streamInvestigation } from "./api.js";

function sseResponse(
  blocks: { event: string; data: unknown }[],
  init: { status?: number; ok?: boolean } = {},
): Response {
  const text = blocks
    .map((b) => `event: ${b.event}\ndata: ${JSON.stringify(b.data)}\n\n`)
    .join("");
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
  return new Response(body, { status: init.status ?? 200 });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("streamInvestigation", () => {
  it("parses SSE events incrementally, in order", async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse([
        { event: "investigation.started", data: { traceId: "t1" } },
        {
          event: "source.completed",
          data: { activityId: 1, source: "linear", ok: true },
        },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const events = [];
    for await (const message of streamInvestigation("question")) {
      events.push(message);
    }

    expect(events).toEqual([
      { event: "investigation.started", data: { traceId: "t1" } },
      {
        event: "source.completed",
        data: { activityId: 1, source: "linear", ok: true },
      },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/investigate",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ question: "question" }),
      }),
    );
  });

  it("throws when the response is not ok, falling back to a generic message with no body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 500 })),
    );
    await expect(async () => {
      for await (const _ of streamInvestigation("q")) {
        // drain
      }
    }).rejects.toThrow(/500/);
  });

  it("surfaces the server's own error code/message on a 429 (e.g. demo_busy)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: {
                code: "demo_busy",
                message:
                  "The demo is currently running another investigation. Please try again in a moment.",
              },
            }),
            { status: 429 },
          ),
      ),
    );
    let caught: unknown;
    try {
      for await (const _ of streamInvestigation("q")) {
        // drain
      }
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ApiRequestError);
    expect((caught as ApiRequestError).code).toBe("demo_busy");
    expect((caught as ApiRequestError).message).toContain(
      "running another investigation",
    );
  });
});

describe("decideProposal", () => {
  it("returns the audit on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ proposalId: "p1", decision: "rejected" }),
            { status: 200 },
          ),
      ),
    );
    const result = await decideProposal("p1", "reject");
    expect(result).toEqual({
      ok: true,
      status: 200,
      audit: { proposalId: "p1", decision: "rejected" },
    });
  });

  it("treats a 502 execution-failure response as a valid audit, not an error envelope", async () => {
    // apps/web/src/presentation.ts still returns a full AuditDTO (error
    // nested under execution.error) with HTTP 502 when the write itself
    // failed — distinct from a 502 caused by a request-level exception,
    // which IS a top-level {error} envelope. Body shape decides, not status.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              proposalId: "p1",
              decision: "approved",
              decidedAt: "2026-01-01T00:00:00.000Z",
              execution: {
                outcome: "failure",
                error: { code: "execution_failed", message: "Failed." },
              },
            }),
            { status: 502 },
          ),
      ),
    );
    const result = await decideProposal("p1", "approve");
    expect(result.ok).toBe(true);
    expect(result.ok && result.audit.execution?.outcome).toBe("failure");
  });

  it("returns a structured error on failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: { code: "proposal_expired", message: "Expired." },
            }),
            { status: 410 },
          ),
      ),
    );
    const result = await decideProposal("p1", "approve");
    expect(result).toEqual({
      ok: false,
      status: 410,
      error: { code: "proposal_expired", message: "Expired." },
    });
  });
});
