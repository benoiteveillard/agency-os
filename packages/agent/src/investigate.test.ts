import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Tracer, type SpanRecord } from "@agency-os/observability";
import type { AgentDependencies } from "./tools.js";
import { investigate, type AnswerTextUpdate } from "./runner.js";

/**
 * Drives the real tool loop and the real Anthropic SDK against a stubbed
 * fetch, so nothing here reaches the network. Each entry is one model turn.
 */
interface ScriptedTurn {
  stop_reason: string | null;
  content: unknown[];
}

const toolUse = (id: string, name: string, input: unknown) => ({
  type: "tool_use",
  id,
  name,
  input,
});
const text = (value: string) => ({ type: "text", text: value });
const endTurn = (value = "Final answer."): ScriptedTurn => ({
  stop_reason: "end_turn",
  content: [text(value)],
});

const requests: Array<Record<string, unknown>> = [];

/** The SSE events the Messages API streams for one complete message. */
function sseEvents(message: Record<string, unknown> & ScriptedTurn): unknown[] {
  const { content, stop_reason, usage, ...rest } = message;
  const events: unknown[] = [
    {
      type: "message_start",
      message: { ...rest, content: [], stop_reason: null, usage },
    },
  ];
  content.forEach((raw, index) => {
    const block = raw as Record<string, unknown>;
    if (block.type === "text") {
      events.push(
        {
          type: "content_block_start",
          index,
          content_block: { type: "text", text: "" },
        },
        {
          type: "content_block_delta",
          index,
          delta: { type: "text_delta", text: block.text },
        },
      );
    } else if (block.type === "tool_use") {
      events.push(
        {
          type: "content_block_start",
          index,
          content_block: { ...block, input: {} },
        },
        {
          type: "content_block_delta",
          index,
          delta: {
            type: "input_json_delta",
            partial_json: JSON.stringify(block.input),
          },
        },
      );
    } else {
      events.push({ type: "content_block_start", index, content_block: block });
    }
    events.push({ type: "content_block_stop", index });
  });
  events.push(
    {
      type: "message_delta",
      delta: { stop_reason, stop_sequence: null },
      usage,
    },
    { type: "message_stop" },
  );
  return events;
}

function scriptModel(turns: ScriptedTurn[]): void {
  let index = 0;
  vi.stubGlobal("fetch", async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    requests.push(body);
    const turn = turns[index++];
    if (!turn) throw new Error("The model was called more often than scripted");
    const message = {
      id: "msg",
      type: "message",
      role: "assistant",
      model: "claude-test",
      stop_sequence: null,
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      ...turn,
    };
    if (!body.stream) {
      return new Response(JSON.stringify(message), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    const sse = sseEvents(message)
      .map((event) => {
        const type = (event as { type: string }).type;
        return `event: ${type}\ndata: ${JSON.stringify(event)}\n\n`;
      })
      .join("");
    return new Response(sse, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  });
}

function deps(): AgentDependencies {
  return {
    projectRegistry: {
      acme: {
        displayName: "Acme",
        linearProjectId: "p",
        linearTeamId: "t",
        githubOwner: "o",
        githubRepo: "r",
        slackChannelId: "c",
      },
    },
    issueTracker: {
      listProjectIssues: async () => ({
        project: {
          id: "p",
          name: "Acme",
          url: "https://linear.app/p",
          targetDate: null,
          health: null,
        },
        truncated: false,
        issues: [],
      }),
      getIssue: async () => {
        throw new Error("not used");
      },
    },
    pullRequestSource: {
      listPullRequests: async () => ({ pullRequests: [], truncated: false }),
      getWorkflowRunStatus: async () => ({ status: "unknown", runs: [] }),
    },
    slackMessageSource: {
      getChannelMessages: async () => ({
        truncated: false,
        messages: [
          {
            ts: "1726142400.000100",
            authorId: "U1",
            text: "Client approval is still missing.",
            isThreadRoot: false,
          },
        ],
      }),
      getThread: async () => ({ messages: [], truncated: false }),
    },
  } as AgentDependencies;
}

function run(now?: Date) {
  const tracer = new Tracer();
  const parentSpan = tracer.startSpan("agent.run", "run");
  return {
    tracer,
    result: investigate("Are we on track?", deps(), {
      anthropicApiKey: "test-key",
      tracer,
      parentSpan,
      now,
    }),
  };
}

const spanNamed = (spans: SpanRecord[], name: string) =>
  spans.find((span) => span.name === name);

const COMPLETE_PROPOSAL = {
  projectSlug: "acme",
  title: "Track the blocker",
  description: "Cut off mid-sent",
  rationale: "No issue tracks it.",
  evidenceIds: ["slack:1726142400.000100"],
};

beforeEach(() => {
  requests.length = 0;
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("investigate stop reasons", () => {
  it("returns the answer on a normal end_turn", async () => {
    scriptModel([endTurn("Done.")]);
    await expect(run().result).resolves.toMatchObject({ answer: "Done." });
  });

  it("fails on a refusal rather than returning an empty success", async () => {
    scriptModel([{ stop_reason: "refusal", content: [] }]);
    await expect(run().result).rejects.toThrow(/stop_reason=refusal/);
  });

  it("fails on a refusal even after earlier evidence was collected", async () => {
    scriptModel([
      {
        stop_reason: "tool_use",
        content: [
          toolUse("t1", "linear_list_project_issues", { projectSlug: "acme" }),
        ],
      },
      { stop_reason: "refusal", content: [text("I can't help with that.")] },
    ]);
    await expect(run().result).rejects.toThrow(/stop_reason=refusal/);
  });

  it("does not present text cut off by max_tokens as a finished answer", async () => {
    scriptModel([
      {
        stop_reason: "max_tokens",
        content: [text("The project is on track because the bl")],
      },
    ]);
    await expect(run().result).rejects.toThrow(/stop_reason=max_tokens/);
  });

  it("treats a stop reason it doesn't know as incomplete", async () => {
    scriptModel([{ stop_reason: "a_new_reason", content: [text("Partial")] }]);
    await expect(run().result).rejects.toThrow(/stop_reason=a_new_reason/);
  });

  it("fails on an empty answer when no assessment carries the conclusion", async () => {
    scriptModel([{ stop_reason: "end_turn", content: [] }]);
    await expect(run().result).rejects.toThrow(/empty response/);
  });

  it("never executes a tool call from a turn truncated by max_tokens", async () => {
    scriptModel([
      {
        stop_reason: "max_tokens",
        content: [toolUse("t1", "propose_linear_issue", COMPLETE_PROPOSAL)],
      },
      endTurn(),
    ]);
    const { result, tracer } = run();
    const outcome = await result;

    expect(outcome.proposedAction).toBeUndefined();
    expect(outcome.trace).toMatchObject([
      { tool: "propose_linear_issue", ok: false },
    ]);
    const span = spanNamed(tracer.getSpans(), "tool.propose_linear_issue");
    expect(span).toMatchObject({
      status: "error",
      errorCategory: "tool_validation",
    });
  });

  it("answers the truncated call with an error so the model can retry within the run", async () => {
    scriptModel([
      {
        stop_reason: "max_tokens",
        content: [toolUse("t1", "propose_linear_issue", COMPLETE_PROPOSAL)],
      },
      {
        stop_reason: "tool_use",
        content: [
          toolUse("t2", "slack_get_channel_messages", { projectSlug: "acme" }),
          toolUse("t3", "propose_linear_issue", {
            ...COMPLETE_PROPOSAL,
            description: "A complete description.",
          }),
        ],
      },
      endTurn(),
    ]);
    const outcome = await run().result;

    const retry = (requests[1]!.messages as Array<{ content: unknown }>).at(-1);
    expect(retry!.content).toMatchObject([
      {
        type: "tool_result",
        tool_use_id: "t1",
        is_error: true,
        content: expect.stringContaining("not executed"),
      },
    ]);
    expect(outcome.proposedAction?.args.description).toBe(
      "A complete description.",
    );
  });
});

describe("investigate model selection", () => {
  it("defaults to Sonnet 5.5 with the server-side fallback, and traces the serving model", async () => {
    scriptModel([endTurn()]);
    const { result, tracer } = run();
    await result;
    expect(requests[0]).toMatchObject({
      model: "claude-sonnet-5-5",
      fallbacks: "default",
    });
    expect(spanNamed(tracer.getSpans(), "model.turn")!.attributes.model).toBe(
      "claude-test",
    );
  });

  it("sends no fallback for a model it isn't enabled on", async () => {
    scriptModel([endTurn()]);
    const tracer = new Tracer();
    await investigate("q", deps(), {
      anthropicApiKey: "k",
      model: "claude-sonnet-5",
      tracer,
      parentSpan: tracer.startSpan("agent.run", "run"),
    });
    expect(requests[0]).not.toHaveProperty("fallbacks");
  });

  it("ignores a tool call and text from the model that declined mid-turn", async () => {
    scriptModel([
      {
        stop_reason: "end_turn",
        content: [
          text("Partial text from the first model"),
          toolUse("t1", "propose_linear_issue", COMPLETE_PROPOSAL),
          {
            type: "fallback",
            from: { model: "claude-sonnet-5-5" },
            to: { model: "claude-sonnet-5" },
          },
          text("The answer from the fallback model."),
        ],
      },
    ]);
    const outcome = await run().result;
    expect(outcome.answer).toBe("The answer from the fallback model.");
    expect(outcome.proposedAction).toBeUndefined();
    expect(outcome.trace).toEqual([]);
  });
});

describe("investigate turn budget", () => {
  const invalidProposal = (id: string): ScriptedTurn => ({
    stop_reason: "tool_use",
    content: [
      toolUse(id, "propose_linear_issue", {
        projectSlug: "acme",
        title: "T",
        description: "D",
      }),
    ],
  });

  it("still reaches a final answer when retries use up every tool turn", async () => {
    // docs/failures.md, trace 17b06d2e8fc8cc89dc93adddbdfc0dc1.
    scriptModel([
      ...Array.from({ length: 7 }, (_, i) => invalidProposal(`t${i}`)),
      endTurn("Slack couldn't be read; here is what I found."),
    ]);
    const outcome = await run().result;

    expect(outcome.answer).toContain("here is what I found");
    expect(requests).toHaveLength(8);
    expect(requests[6]!.tool_choice).toBeUndefined();
    expect(requests[7]!.tool_choice).toEqual({ type: "none" });
    const lastUserTurn = (
      requests[7]!.messages as Array<{ content: Array<{ type: string }> }>
    ).at(-1)!.content;
    expect(lastUserTurn.at(-1)).toMatchObject({
      type: "text",
      text: expect.stringContaining("final answer"),
    });
  });

  it("keeps every tool_result before the closing instruction", async () => {
    scriptModel([
      ...Array.from({ length: 7 }, (_, i) => invalidProposal(`t${i}`)),
      endTurn(),
    ]);
    await run().result;
    const lastUserTurn = (
      requests[7]!.messages as Array<{ content: Array<{ type: string }> }>
    ).at(-1)!.content;
    expect(lastUserTurn[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "t6",
    });
  });
});

describe("investigate deadlines and cancellation", () => {
  it("makes no further model call once the signal has aborted", async () => {
    const controller = new AbortController();
    controller.abort(
      new Error("Investigation cancelled: client disconnected."),
    );
    scriptModel([endTurn()]);
    const tracer = new Tracer();
    await expect(
      investigate("q", deps(), {
        anthropicApiKey: "k",
        tracer,
        parentSpan: tracer.startSpan("agent.run", "run"),
        signal: controller.signal,
      }),
    ).rejects.toThrow("client disconnected");
    expect(requests).toHaveLength(0);
  });

  it("stops between turns when the signal aborts during a tool call", async () => {
    const controller = new AbortController();
    const slow = deps();
    slow.issueTracker.listProjectIssues = () => {
      controller.abort(new Error("Investigation exceeded its deadline."));
      return new Promise(() => {});
    };
    scriptModel([
      {
        stop_reason: "tool_use",
        content: [
          toolUse("t1", "linear_list_project_issues", { projectSlug: "acme" }),
        ],
      },
      endTurn(),
    ]);
    const tracer = new Tracer();
    await expect(
      investigate("q", slow, {
        anthropicApiKey: "k",
        tracer,
        parentSpan: tracer.startSpan("agent.run", "run"),
        signal: controller.signal,
      }),
    ).rejects.toThrow("exceeded its deadline");
    expect(requests).toHaveLength(1);
  });
});

describe("investigate temporal context", () => {
  it("tells the model today's date", async () => {
    scriptModel([endTurn()]);
    await run(new Date("2026-11-02T15:30:00Z")).result;

    const system = requests[0]!.system as Array<{ text: string }>;
    expect(system[0]!.text).toContain("Today's date is 2026-11-02 (UTC)");
  });

  it("gives the model an ISO sentAt for Slack messages, not only epoch seconds", async () => {
    scriptModel([
      {
        stop_reason: "tool_use",
        content: [
          toolUse("t1", "slack_get_channel_messages", { projectSlug: "acme" }),
        ],
      },
      endTurn(),
    ]);
    await run().result;

    const toolTurn = (requests[1]!.messages as Array<{ content: unknown }>).at(
      -1,
    )!.content as Array<{ content: string }>;
    expect(JSON.parse(toolTurn[0]!.content)).toMatchObject({
      messages: [
        { ts: "1726142400.000100", sentAt: "2024-09-12T12:00:00.000Z" },
      ],
      truncated: false,
    });
  });
});

describe("investigate answer streaming", () => {
  async function streamed(turns: ScriptedTurn[]) {
    scriptModel(turns);
    const updates: AnswerTextUpdate[] = [];
    const tracer = new Tracer();
    const result = await investigate("Are we on track?", deps(), {
      anthropicApiKey: "test-key",
      tracer,
      parentSpan: tracer.startSpan("agent.run", "run"),
      onAnswerText: (update) => updates.push(update),
    });
    return { result, updates };
  }

  /** What a reader would see after applying every update in order. */
  const visible = (updates: AnswerTextUpdate[]) =>
    updates.reduce(
      (text, update) => (update.type === "reset" ? "" : text + update.text),
      "",
    );

  it("streams the answer, starting each model turn from empty", async () => {
    const { result, updates } = await streamed([
      {
        stop_reason: "tool_use",
        content: [
          text("Checking Slack first."),
          toolUse("t1", "slack_get_channel_messages", { projectSlug: "acme" }),
        ],
      },
      endTurn("Approval is still missing."),
    ]);

    expect(updates.filter((update) => update.type === "reset")).toHaveLength(2);
    expect(visible(updates)).toBe("Approval is still missing.");
    expect(result.answer).toBe("Approval is still missing.");
  });

  it("drops the declined model's partial text when a fallback takes over", async () => {
    const { updates } = await streamed([
      {
        stop_reason: "end_turn",
        content: [
          text("Partial text from the first model"),
          {
            type: "fallback",
            from: { model: "claude-sonnet-5-5" },
            to: { model: "claude-sonnet-5" },
          },
          text("The answer from the fallback model."),
        ],
      },
    ]);

    expect(visible(updates)).toBe("The answer from the fallback model.");
  });
});
