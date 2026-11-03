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

function mockFetch(
  handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
) {
  const fetchMock = vi.fn(handler);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("initial state", () => {
  it("explains the product before any interaction", () => {
    render(<App />);
    expect(
      screen.getByRole("heading", {
        name: "What do you need to know about this launch?",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("Acme Website Migration")).toBeInTheDocument();
    expect(
      screen.getByText(/this project.s Linear, GitHub and Slack/),
    ).toBeInTheDocument();
    // No launch date here: nothing has retrieved one yet.
    expect(screen.queryByText(/Target launch/)).not.toBeInTheDocument();
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
    fireEvent.click(screen.getByRole("button", { name: "Investigate" }));
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
    const sources = await screen.findByRole("group", {
      name: "Sources checked",
    });
    expect(sources).toHaveTextContent(/Linear checked/);
    expect(sources).toHaveTextContent(/GitHub checked/);
    // Slack never appeared in this stream, so it must not be fabricated as checked.
    expect(sources).not.toHaveTextContent(/Slack checked/);
    expect(sources).toHaveTextContent(/Slack not checked/);
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
    expect(screen.getByText("Decides status")).toBeInTheDocument();
    expect(screen.getByText("Supports")).toBeInTheDocument();
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
    expect(
      screen.queryByText("What is blocking the launch"),
    ).not.toBeInTheDocument();
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
        projectName: "Acme Website Migration",
        evidenceIds: ["slack:100.001"],
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
      screen.getByRole("button", { name: "Approve and create issue" }),
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
        screen.getByText(/No change was made in Linear/),
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
    fireEvent.click(
      screen.getByRole("button", { name: "Approve and create issue" }),
    );
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
    fireEvent.click(
      screen.getByRole("button", { name: "Approve and create issue" }),
    );
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
    fireEvent.click(
      screen.getByRole("button", { name: "Approve and create issue" }),
    );
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

describe("the answer is always visible", () => {
  async function ask(result: InvestigationResultDTO, extra: SSEMessage[] = []) {
    mockFetch(async () =>
      sseResponse([
        { event: "investigation.started", data: { traceId: "t" } },
        ...extra,
        { event: "investigation.completed", data: result },
      ]),
    );
    render(<App />);
    fireEvent.click(
      screen.getByRole("button", {
        name: /Are we still on track to launch Project Acme/,
      }),
    );
    await screen.findByRole("heading", { name: "Investigation brief" });
  }

  it("shows the answer directly for a question with no assessment", async () => {
    await ask(baseResult({ answer: "PR #12 is failing CI." }));
    expect(screen.getByText("PR #12 is failing CI.")).toBeInTheDocument();
    expect(screen.queryByText("Full analysis")).not.toBeInTheDocument();
  });

  it("shows the answer directly for a verdict with no blockers", async () => {
    await ask(
      baseResult({
        answer: "Everything is moving.",
        assessment: { verdict: "on_track", summary: "All good.", blockers: [] },
      }),
    );
    expect(screen.getByText("Everything is moving.")).toBeInTheDocument();
  });

  it("leads the verdict with the finding itself, as the heading", async () => {
    await ask(
      baseResult({
        assessment: {
          verdict: "on_track",
          summary: "Nothing threatens the date.",
          blockers: [],
        },
      }),
    );
    expect(
      screen.getByRole("heading", { name: "Nothing threatens the date." }),
    ).toBeInTheDocument();
  });

  it("says on the verdict itself when a source couldn't be checked", async () => {
    await ask(
      baseResult({
        assessment: { verdict: "on_track", summary: "Fine.", blockers: [] },
      }),
      [
        { event: "source.started", data: { activityId: 1, source: "slack" } },
        {
          event: "source.completed",
          data: { activityId: 1, source: "slack", ok: false },
        },
      ],
    );
    expect(
      screen.getByRole("region", { name: "Assessment verdict" }),
    ).toHaveTextContent(
      /Slack couldn.t be checked, so this verdict doesn.t account for it/,
    );
  });
});

describe("asking", () => {
  const typeQuestion = () => {
    const box = screen.getByRole("textbox", { name: "Ask about this project" });
    fireEvent.change(box, { target: { value: "What's blocking us?" } });
    return box;
  };

  it("asks on Enter and adds a line on Shift+Enter", async () => {
    const fetchMock = mockFetch(async () => sseResponse(fullSSESequence()));
    render(<App />);
    const box = typeQuestion();
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });

  it("can cancel a running investigation, which aborts the request", async () => {
    let signal: AbortSignal | undefined;
    mockFetch(async (_input, init) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>(() => {});
    });
    render(<App />);
    typeQuestion();
    fireEvent.click(screen.getByRole("button", { name: "Investigate" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(signal?.aborted).toBe(true);
    expect(
      screen.getByRole("button", { name: "Investigate" }),
    ).toBeInTheDocument();
  });
});

describe("verifiable evidence", () => {
  function resultWithCitation(): InvestigationResultDTO {
    return baseResult({
      assessment: {
        verdict: "high_risk",
        summary: "Launch is materially threatened.",
        blockers: [
          {
            title: "Client approval missing",
            explanation: "Not confirmed.",
            sources: [{ evidenceId: "slack:100.001", role: "corroborating" }],
          },
        ],
      },
      evidence: [
        {
          evidenceId: "slack:100.001",
          source: "slack",
          id: "100.001",
          timestamp: "2026-09-12T10:00:00.000Z",
          excerpt: 'U1: "<b>Client approval</b> is still missing."',
        },
      ],
    });
  }

  it("shows what a cited source says and its date, as plain text", async () => {
    mockFetch(async () =>
      sseResponse([
        { event: "investigation.started", data: { traceId: "t" } },
        { event: "investigation.completed", data: resultWithCitation() },
      ]),
    );
    render(<App />);
    fireEvent.click(
      screen.getByRole("button", {
        name: /Are we still on track to launch Project Acme/,
      }),
    );
    expect(
      await screen.findByText('U1: "<b>Client approval</b> is still missing."'),
    ).toBeInTheDocument();
    expect(screen.getByText("12 Sep 2026")).toBeInTheDocument();
    expect(document.querySelector(".evidence-excerpt b")).toBeNull();
  });

  it("shows the rationale, target project and evidence on a proposal", async () => {
    mockFetch(async () =>
      sseResponse([
        { event: "investigation.started", data: { traceId: "t" } },
        {
          event: "investigation.completed",
          data: {
            ...resultWithCitation(),
            proposedActionPresentation: {
              proposalId: "p",
              kind: "linear_create_issue",
              title: "Chase the approval",
              description: "Ask the account owner.",
              priority: 2,
              teamId: "team-1",
              projectId: "project-1",
              projectName: "Acme Website Migration",
              rationale: "Nobody owns the approval yet.",
              evidenceIds: ["slack:100.001"],
              expiresAt: "2030-01-01T00:00:00.000Z",
            },
          },
        },
      ]),
    );
    render(<App />);
    fireEvent.click(
      screen.getByRole("button", {
        name: /Are we still on track to launch Project Acme/,
      }),
    );
    expect(
      await screen.findByText("Nobody owns the approval yet."),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/this exact issue goes to Linear/),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Project: Acme Website Migration"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("list", { name: "Evidence for this action" }),
    ).toHaveTextContent(/Slack\s*message/);
    // Already quoted under the blocker, so it isn't printed a second time.
    expect(screen.getAllByText(/is still missing/)).toHaveLength(1);
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

describe("what the redesigned brief adds", () => {
  function startSuggested() {
    fireEvent.click(
      screen.getByRole("button", {
        name: /Are we still on track to launch Project Acme/,
      }),
    );
  }

  it("asks for a question instead of sending an empty one", () => {
    const fetchMock = mockFetch(async () => sseResponse(fullSSESequence()));
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Investigate" }));
    expect(screen.getByText("Type a question first.")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows the verdict as soon as the stream reports it, before the brief", async () => {
    mockFetch(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              const ready: SSEMessage = {
                event: "assessment.ready",
                data: { verdict: "high_risk", blockerCount: 2 },
              };
              controller.enqueue(
                new TextEncoder().encode(
                  `event: ${ready.event}\ndata: ${JSON.stringify(ready.data)}\n\n`,
                ),
              );
              // Left open: the run is still writing its brief.
            },
          }),
          { status: 200 },
        ),
    );
    render(<App />);
    startSuggested();
    expect(await screen.findByText(/2 blockers found/)).toBeInTheDocument();
    expect(screen.getByText("High risk")).toBeInTheDocument();
    expect(screen.queryByText("Investigation brief")).not.toBeInTheDocument();
  });

  it("states the age of the newest evidence on the verdict", async () => {
    const yesterday = new Date(Date.now() - 86_400_000 - 1000).toISOString();
    mockFetch(async () =>
      sseResponse([
        {
          event: "investigation.completed",
          data: baseResult({
            assessment: { verdict: "at_risk", summary: "Tight.", blockers: [] },
            evidence: [
              {
                evidenceId: "linear:OLD",
                source: "linear",
                id: "OLD",
                timestamp: "2020-01-01T00:00:00.000Z",
              },
              {
                evidenceId: "linear:NEW",
                source: "linear",
                id: "NEW",
                timestamp: yesterday,
              },
            ],
          }),
        },
      ]),
    );
    render(<App />);
    startSuggested();
    expect(await screen.findByText(/, 1 day old$/)).toBeInTheDocument();
  });

  it("doesn't invent an evidence age when nothing retrieved has a date", async () => {
    mockFetch(async () => sseResponse(fullSSESequence()));
    render(<App />);
    startSuggested();
    await screen.findByText("High risk");
    expect(screen.queryByText("Newest evidence")).not.toBeInTheDocument();
  });

  it("removes the approve button once a proposal has expired, without calling the server", async () => {
    const fetchMock = mockFetch(async () =>
      sseResponse(
        fullSSESequence({
          proposedActionPresentation: {
            proposalId: "p",
            kind: "linear_create_issue",
            title: "Chase the approval",
            description: "Ask.",
            priority: 2,
            teamId: "t",
            projectId: "project",
            projectName: "Acme Website Migration",
            rationale: "Why.",
            evidenceIds: [],
            expiresAt: new Date(Date.now() - 1000).toISOString(),
          },
        }),
      ),
    );
    render(<App />);
    startSuggested();
    expect(
      await screen.findByText("This proposal expired"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Approve and create issue" }),
    ).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns to the question form from a finished brief", async () => {
    mockFetch(async () => sseResponse(fullSSESequence()));
    render(<App />);
    startSuggested();
    fireEvent.click(
      await screen.findByRole("button", { name: "New question" }),
    );
    expect(
      screen.getByRole("textbox", { name: "Ask about this project" }),
    ).toBeInTheDocument();
  });
});
