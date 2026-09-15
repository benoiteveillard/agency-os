// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { App } from "./App.js";
import type {
  Assessment,
  InvestigationResultDTO,
  SSEMessage,
} from "./types.js";

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
    { status: 200 },
  );
}

function baseResult(
  overrides: Partial<InvestigationResultDTO> = {},
): InvestigationResultDTO {
  return {
    answer: "Full narrative answer explaining the verdict in detail.",
    evidence: [
      {
        evidenceId: "linear:JUS-6",
        source: "linear",
        id: "JUS-6",
        url: "https://linear.app/acme/issue/JUS-6",
      },
      { evidenceId: "slack:100.001", source: "slack", id: "100.001" },
    ],
    metadata: {
      traceId: "trace-abc123",
      durationMs: 42800,
      toolCallCount: 11,
      inputTokens: 18400,
      outputTokens: 2100,
    },
    ...overrides,
  };
}

function highRiskAssessment(): Assessment {
  return {
    verdict: "high_risk",
    summary: "Launch is materially threatened.",
    blockers: [
      {
        title: "Client approval missing",
        explanation:
          "Formal approval required for launch has not been confirmed.",
        sources: [
          { evidenceId: "linear:JUS-6", role: "authoritative" },
          { evidenceId: "slack:100.001", role: "corroborating" },
        ],
      },
    ],
    uncertainty: ["Safari regression status has not been reconfirmed."],
  };
}

function fullSSESequence(overrides: Partial<InvestigationResultDTO> = {}) {
  const result = baseResult({ assessment: highRiskAssessment(), ...overrides });
  return [
    {
      event: "investigation.started",
      data: { traceId: result.metadata.traceId },
    },
    { event: "source.started", data: { activityId: 1, source: "linear" } },
    {
      event: "source.completed",
      data: { activityId: 1, source: "linear", ok: true },
    },
    { event: "source.started", data: { activityId: 2, source: "github" } },
    {
      event: "source.completed",
      data: { activityId: 2, source: "github", ok: true },
    },
    { event: "assessment.started", data: { activityId: 3 } },
    ...(result.assessment
      ? [
          {
            event: "assessment.ready",
            data: {
              verdict: result.assessment.verdict,
              blockerCount: result.assessment.blockers.length,
            },
          },
        ]
      : []),
    { event: "investigation.completed", data: result },
  ] as SSEMessage[];
}

function mockFetch(handler: (input: RequestInfo | URL) => Promise<Response>) {
  vi.stubGlobal("fetch", vi.fn(handler));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("initial state", () => {
  it("explains the product before any interaction", () => {
    render(<App />);
    expect(
      screen.getByRole("heading", { name: "Acme Website Migration" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Target launch/)).toBeInTheDocument();
    expect(screen.getByText("Linear")).toBeInTheDocument();
    expect(screen.getByText("GitHub")).toBeInTheDocument();
    expect(screen.getByText("Slack")).toBeInTheDocument();
    expect(
      screen.getByText(/Are we still on track to launch Project Acme/),
    ).toBeInTheDocument();
    expect(screen.getByText(/synthetic/)).toBeInTheDocument();
  });
});

describe("asking a question", () => {
  it("runs the investigation via the suggested-question chip", async () => {
    mockFetch(async () => sseResponse(fullSSESequence()));
    render(<App />);
    fireEvent.click(
      screen.getByRole("button", {
        name: /Are we still on track to launch Project Acme/,
      }),
    );
    await waitFor(() =>
      expect(screen.getByText("High risk")).toBeInTheDocument(),
    );
  });

  it("runs a custom typed question", async () => {
    let sentBody = "";
    mockFetch(async (_input, init?: RequestInit) => {
      sentBody = String((init as RequestInit)?.body ?? "");
      return sseResponse(fullSSESequence());
    });
    render(<App />);
    fireEvent.change(screen.getByLabelText("Ask about this project"), {
      target: { value: "Is JUS-6 blocking launch?" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    await waitFor(() =>
      expect(screen.getByText("High risk")).toBeInTheDocument(),
    );
    expect(sentBody).toContain("Is JUS-6 blocking launch?");
  });
});

describe("live progress", () => {
  it("renders only sources actually reported by SSE, no fake steps", async () => {
    mockFetch(async () => sseResponse(fullSSESequence()));
    render(<App />);
    fireEvent.click(
      screen.getByRole("button", {
        name: /Are we still on track to launch Project Acme/,
      }),
    );
    await waitFor(() => expect(screen.getByText("Linear")).toBeInTheDocument());
    expect(screen.getByText("GitHub")).toBeInTheDocument();
    // Slack never appeared in this stream — must not be fabricated.
    expect(
      screen.queryByText("Slack", { selector: ".progress-item__label" }),
    ).not.toBeInTheDocument();
  });
});

describe("assessment verdicts", () => {
  it("renders a high_risk verdict with blockers and their source roles", async () => {
    mockFetch(async () => sseResponse(fullSSESequence()));
    render(<App />);
    fireEvent.click(
      screen.getByRole("button", {
        name: /Are we still on track to launch Project Acme/,
      }),
    );
    await waitFor(() =>
      expect(screen.getByText("High risk")).toBeInTheDocument(),
    );
    expect(screen.getByText("Client approval missing")).toBeInTheDocument();
    expect(screen.getByText("Authoritative")).toBeInTheDocument();
    expect(screen.getByText("Corroborating")).toBeInTheDocument();
    expect(
      screen.getByText(/Safari regression status has not been reconfirmed/),
    ).toBeInTheDocument();
  });

  it("renders an on_track verdict without a blockers section", async () => {
    mockFetch(async () =>
      sseResponse(
        fullSSESequence({
          assessment: {
            verdict: "on_track",
            summary: "No unresolved threat.",
            blockers: [],
          },
        }),
      ),
    );
    render(<App />);
    fireEvent.click(
      screen.getByRole("button", {
        name: /Are we still on track to launch Project Acme/,
      }),
    );
    await waitFor(() =>
      expect(screen.getByText("On track")).toBeInTheDocument(),
    );
    expect(screen.queryByText("Launch blockers")).not.toBeInTheDocument();
  });

  it("renders insufficient_evidence as a valid assessment state, not an error", async () => {
    mockFetch(async () =>
      sseResponse(
        fullSSESequence({
          assessment: {
            verdict: "insufficient_evidence",
            summary: "Not enough evidence to judge readiness.",
            blockers: [],
          },
        }),
      ),
    );
    render(<App />);
    fireEvent.click(
      screen.getByRole("button", {
        name: /Are we still on track to launch Project Acme/,
      }),
    );
    await waitFor(() =>
      expect(screen.getByText("Insufficient evidence")).toBeInTheDocument(),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("proposed action", () => {
  function completedWithProposal() {
    return fullSSESequence({
      proposedActionPresentation: {
        proposalId: "proposal-1",
        kind: "linear_create_issue",
        title: "Escalate missing client approval",
        description: "Create a tracked follow-up.",
        priority: 1,
        teamId: "team-1",
        projectId: "project-1",
        rationale: "No tracking issue exists yet.",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    });
  }

  async function renderWithProposal() {
    mockFetch(async (input) => {
      const url = String(input);
      if (url.includes("/api/investigate"))
        return sseResponse(completedWithProposal());
      throw new Error(`unexpected fetch: ${url}`);
    });
    render(<App />);
    fireEvent.click(
      screen.getByRole("button", {
        name: /Are we still on track to launch Project Acme/,
      }),
    );
    await waitFor(() =>
      expect(
        screen.getByText("Escalate missing client approval"),
      ).toBeInTheDocument(),
    );
  }

  it("shows a pending proposal with human-controlled actions, never internal digest/JSON", async () => {
    await renderWithProposal();
    expect(
      screen.getByRole("button", { name: "Approve action" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reject" })).toBeInTheDocument();
    expect(screen.queryByText(/approvalDigest/)).not.toBeInTheDocument();
    expect(screen.queryByText("team-1")).not.toBeInTheDocument();
  });

  it("rejects through the real decide endpoint", async () => {
    await renderWithProposal();
    const decideMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            proposalId: "proposal-1",
            decision: "rejected",
            decidedAt: new Date().toISOString(),
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", decideMock);
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    await waitFor(() =>
      expect(
        screen.getByText("Action rejected — no changes were made."),
      ).toBeInTheDocument(),
    );
    expect(decideMock).toHaveBeenCalledWith(
      "/api/proposals/proposal-1/decide",
      expect.objectContaining({ body: JSON.stringify({ decision: "reject" }) }),
    );
  });

  it("shows the approved+confirmed visual state from a mocked API response, never a real write in tests", async () => {
    await renderWithProposal();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              proposalId: "proposal-1",
              decision: "approved",
              decidedAt: new Date().toISOString(),
              execution: {
                outcome: "success",
                createdIssue: {
                  identifier: "JUS-61",
                  title: "Escalate missing client approval",
                  url: "https://linear.app/acme/issue/JUS-61",
                },
              },
            }),
            { status: 200 },
          ),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Approve action" }));
    await waitFor(() =>
      expect(screen.getByText(/Approved and created/)).toBeInTheDocument(),
    );
    expect(screen.getByRole("link", { name: "JUS-61" })).toHaveAttribute(
      "href",
      "https://linear.app/acme/issue/JUS-61",
    );
  });

  it("clearly reports execution failure without optimistic success", async () => {
    await renderWithProposal();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              proposalId: "proposal-1",
              decision: "approved",
              decidedAt: new Date().toISOString(),
              execution: {
                outcome: "failure",
                error: { code: "execution_failed", message: "Failed." },
              },
            }),
            { status: 502 },
          ),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Approve action" }));
    await waitFor(() =>
      expect(
        screen.getByText(/not be retried automatically/),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText(/Approved and created/)).not.toBeInTheDocument();
  });

  it("explains an expired proposal instead of a generic error", async () => {
    await renderWithProposal();
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
    fireEvent.click(screen.getByRole("button", { name: "Approve action" }));
    await waitFor(() =>
      expect(
        screen.getByText(
          "This recommendation expired. Run the investigation again before approving it.",
        ),
      ).toBeInTheDocument(),
    );
  });
});

describe("investigation failure and retry", () => {
  it("shows a polished failure state and retries cleanly", async () => {
    let call = 0;
    mockFetch(async () => {
      call += 1;
      if (call === 1) {
        return sseResponse([
          { event: "investigation.started", data: { traceId: "t1" } },
          {
            event: "investigation.failed",
            data: { error: { code: "investigation_failed", message: "x" } },
          },
        ]);
      }
      return sseResponse(fullSSESequence());
    });
    render(<App />);
    fireEvent.click(
      screen.getByRole("button", {
        name: /Are we still on track to launch Project Acme/,
      }),
    );
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(
      screen.getByText("The investigation could not complete"),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() =>
      expect(screen.getByText("High risk")).toBeInTheDocument(),
    );
    // The stale failure card must be gone, not layered under the new result.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("metadata and privacy", () => {
  it("renders accurate metadata and never leaks raw trace/tool payloads", async () => {
    mockFetch(async () => sseResponse(fullSSESequence()));
    render(<App />);
    fireEvent.click(
      screen.getByRole("button", {
        name: /Are we still on track to launch Project Acme/,
      }),
    );
    await waitFor(() =>
      expect(screen.getByText("High risk")).toBeInTheDocument(),
    );
    expect(screen.getByText("42.8s")).toBeInTheDocument();
    expect(screen.getByText("11")).toBeInTheDocument();
    expect(screen.getByText("18.4k")).toBeInTheDocument();
    expect(screen.getByText("2.1k")).toBeInTheDocument();
    expect(screen.getByText("trace-abc123")).toBeInTheDocument();

    const html = document.body.innerHTML;
    expect(html).not.toMatch(/spanId|parentSpanId|"category":"tool"/);
  });
});
