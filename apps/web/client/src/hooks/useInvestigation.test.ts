// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useInvestigation } from "./useInvestigation.js";
import type { SSEMessage } from "../types.js";

function sseResponse(messages: SSEMessage[]): Response {
  const text = messages
    .map((m) => `event: ${m.event}\ndata: ${JSON.stringify(m.data)}\n\n`)
    .join("");
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useInvestigation", () => {
  it("collapses repeated source activity from multiple tool calls into one row", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([
          { event: "investigation.started", data: { traceId: "t1" } },
          { event: "source.started", data: { activityId: 1, source: "slack" } },
          {
            event: "source.completed",
            data: { activityId: 1, source: "slack", ok: true },
          },
          { event: "source.started", data: { activityId: 2, source: "slack" } },
          {
            event: "source.completed",
            data: { activityId: 2, source: "slack", ok: true },
          },
          {
            event: "investigation.completed",
            data: {
              answer: "done",
              evidence: [],
              metadata: { traceId: "t1", durationMs: 1, toolCallCount: 2 },
            },
          },
        ]),
      ),
    );
    const { result } = renderHook(() => useInvestigation());
    act(() => {
      void result.current.run("q");
    });
    await waitFor(() => expect(result.current.state.phase).toBe("completed"));
    const sourceActivities =
      "activities" in result.current.state
        ? result.current.state.activities.filter((a) => a.kind === "source")
        : [];
    expect(sourceActivities).toHaveLength(1);
  });

  it("marks the assessing step done only when assessment.ready arrives, never regressing after done", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([
          { event: "investigation.started", data: { traceId: "t1" } },
          { event: "assessment.started", data: { activityId: 1 } },
          {
            event: "assessment.ready",
            data: { verdict: "on_track", blockerCount: 0 },
          },
          { event: "assessment.started", data: { activityId: 2 } },
          {
            event: "investigation.completed",
            data: {
              answer: "done",
              evidence: [],
              metadata: { traceId: "t1", durationMs: 1, toolCallCount: 1 },
            },
          },
        ]),
      ),
    );
    const { result } = renderHook(() => useInvestigation());
    act(() => {
      void result.current.run("q");
    });
    await waitFor(() => expect(result.current.state.phase).toBe("completed"));
    const assessing =
      "activities" in result.current.state
        ? result.current.state.activities.find((a) => a.kind === "assessing")
        : undefined;
    expect(assessing?.status).toBe("done");
  });

  it("resets cleanly on a new run — no leftover activities or result", async () => {
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call += 1;
        if (call === 1) {
          return sseResponse([
            { event: "investigation.started", data: { traceId: "t1" } },
            {
              event: "source.started",
              data: { activityId: 1, source: "linear" },
            },
            {
              event: "investigation.failed",
              data: { error: { code: "x", message: "x" } },
            },
          ]);
        }
        return sseResponse([
          { event: "investigation.started", data: { traceId: "t2" } },
          {
            event: "investigation.completed",
            data: {
              answer: "done",
              evidence: [],
              metadata: { traceId: "t2", durationMs: 1, toolCallCount: 0 },
            },
          },
        ]);
      }),
    );
    const { result } = renderHook(() => useInvestigation());
    act(() => {
      void result.current.run("q1");
    });
    await waitFor(() => expect(result.current.state.phase).toBe("failed"));

    act(() => {
      void result.current.run("q2");
    });
    await waitFor(() => expect(result.current.state.phase).toBe("running"));
    expect(
      "activities" in result.current.state
        ? result.current.state.activities
        : null,
    ).toEqual([]);

    await waitFor(() => expect(result.current.state.phase).toBe("completed"));
  });
});
