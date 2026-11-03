import Anthropic from "@anthropic-ai/sdk";
import {
  bounded,
  type Evidence,
  type InvestigationResult,
  type ToolCallRecord,
} from "@agency-os/shared";
import {
  categorizeError,
  truncateErrorMessage,
  type Span,
  type Tracer,
} from "@agency-os/observability";
import {
  TOOLS,
  executeTool,
  type AgentDependencies,
  type ProposalState,
  type AssessmentState,
} from "./tools.js";
import { buildSystemPrompt } from "./prompts.js";
import { toolCallAttributes } from "./trace-attributes.js";

type BetaContentBlock = Anthropic.Beta.Messages.BetaContentBlock;

// Chosen on a measured comparison: see "Comparing models" in docs/evaluation.md.
const DEFAULT_MODEL = "claude-sonnet-5-5";
// Lets the API retry a declined request on another model within the same call.
// On Sonnet 5.5 this covers its cyber and frontier_llm declines, which matter
// here because retrieved text is untrusted and can trip a classifier on benign
// work. Any other decline still arrives as stop_reason "refusal" and fails the
// run.
const SERVER_FALLBACK_MODELS = new Set(["claude-sonnet-5-5"]);
const SERVER_FALLBACK_BETA = "server-side-fallback-2026-07-01";
const CACHE_BREAKPOINT: Anthropic.Beta.Messages.BetaCacheControlEphemeral = {
  type: "ephemeral",
};

/**
 * Phase 7.3.2 finding: prompt caching was never wired up anywhere in this
 * codebase (`cacheReadInputTokens`/`cacheCreationInputTokens` were 0 across
 * every one of 601 recorded traces) — every one of a multi-turn
 * investigation's several tool-loop turns was re-sending the full system
 * prompt, tool schemas, and entire growing conversation history as fresh,
 * full-price input tokens. Marks the end of the (static, ~2 tool-call
 * duration-independent) tools array as one of up to 4 allowed cache
 * breakpoints per request; `TOOLS` itself is a module-level constant
 * (tools.ts) reused across every investigate() call, so this is computed
 * once, not per-call. Pure metadata addition — does not change what any
 * tool does or how its input is validated.
 */
const TOOLS_WITH_CACHE: Anthropic.Beta.Messages.BetaTool[] = TOOLS.map(
  (tool, index) =>
    index === TOOLS.length - 1
      ? { ...tool, cache_control: CACHE_BREAKPOINT }
      : tool,
);
// Billed on what's generated, not on this ceiling, and it also has to cover
// the model's own thinking on the same turn. 16000 is the largest value that
// stays comfortably under the SDK's non-streaming timeout. Hitting it no longer
// risks a silent truncation: see the stop_reason handling in investigate().
const MAX_TOKENS = 16000;
// Safety cap on the tool-use loop so a confused model can't run forever.
const MAX_TOOL_TURNS = 8;
// One hung call shouldn't hold a whole investigation. The SDK's default is 10
// minutes per attempt, retried twice. Tools get less: every one is a plain read
// or an in-memory check, and a timeout is reported to the model like any other
// tool failure, so it can still answer from what it has.
const MODEL_REQUEST_TIMEOUT_MS = 120_000;
const TOOL_TIMEOUT_MS = 30_000;
const INCOMPLETE_ANSWER_PREFIX = "Model stopped before a complete answer";

/**
 * The same piece of evidence can legitimately be returned by two different
 * tool calls — e.g. a Slack thread's root message comes back from both
 * slack_get_channel_messages and slack_get_thread — since each tool call is
 * correct in isolation. Dedupes the accumulated list by (source, id) before
 * it's returned, keeping the first occurrence. Applied once, here, rather
 * than in each tool's evidence-building code, since it's a property of
 * accumulating evidence across calls, not of any one source.
 */
export function dedupeEvidence(evidence: Evidence[]): Evidence[] {
  const seen = new Set<string>();
  return evidence.filter((item) => {
    const key = `${item.source}:${item.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * After a fallback mid-output, thinking and tool_use blocks written before the
 * switch belong to the model that declined: the API requires them left out when
 * echoing the turn back, and a tool call from them must not run. Text can be
 * kept but was superseded, so everything before the last switch is dropped.
 */
export function afterLastFallback(
  content: BetaContentBlock[],
): BetaContentBlock[] {
  const boundary = content.map((block) => block.type).lastIndexOf("fallback");
  return boundary === -1 ? content : content.slice(boundary + 1);
}

export interface InvestigateOptions {
  anthropicApiKey: string;
  model?: string;
  /** The whole CLI lifecycle (investigation + approval + execution) is one trace — see apps/cli/src/index.ts, which owns the tracer and the agent.run root span. */
  tracer: Tracer;
  parentSpan: Span;
  /** Overridable for tests; the current date given to the model in the system prompt. */
  now?: Date;
  /**
   * Ends the run as soon as it aborts, rejecting with the signal's reason. No
   * further model calls are made, so nothing more is billed.
   */
  signal?: AbortSignal;
}

/**
 * Hand-rolled tool-use loop (not the SDK's beta toolRunner) so tool
 * dispatch, error handling, and tracing stay explicit and are the natural
 * place to add human approval gating once write tools exist (Phase 3).
 */
export async function investigate(
  question: string,
  deps: AgentDependencies,
  options: InvestigateOptions,
): Promise<InvestigationResult> {
  const client = new Anthropic({
    apiKey: options.anthropicApiKey,
    timeout: MODEL_REQUEST_TIMEOUT_MS,
  });
  const model = options.model ?? DEFAULT_MODEL;
  const { tracer, parentSpan, signal } = options;
  // Array-of-blocks form (rather than a plain string) so the system prompt
  // itself can carry a cache breakpoint — see TOOLS_WITH_CACHE above for
  // why this matters. Per-call, not module-level: varies with
  // deps.projectRegistry.
  const system: Anthropic.Beta.Messages.BetaTextBlockParam[] = [
    {
      type: "text",
      text: buildSystemPrompt(deps.projectRegistry, options.now),
      cache_control: CACHE_BREAKPOINT,
    },
  ];

  const messages: Anthropic.Beta.Messages.BetaMessageParam[] = [
    { role: "user", content: question },
  ];
  const evidence: Evidence[] = [];
  const trace: ToolCallRecord[] = [];
  // Fresh per investigate() call — never part of AgentDependencies, which
  // is constructed once and shouldn't carry per-run mutable state.
  const proposalState: ProposalState = {};
  const assessmentState: AssessmentState = {};

  // Rolling third cache breakpoint (system + tools above are the other
  // two, both static) for the growing conversation itself: at most one
  // alive at a time, moved onto the newest tool_result block each turn so
  // a later turn's request re-reads everything before it from cache
  // instead of resending the whole accumulated history at full price.
  // Anthropic allows up to 4 breakpoints per request; never removing the
  // previous one would grow unboundedly across MAX_TOOL_TURNS turns.
  let cacheBreakpointBlock:
    | {
        cache_control?: Anthropic.Beta.Messages.BetaCacheControlEphemeral | null;
      }
    | undefined;
  function moveCacheBreakpoint(block: {
    cache_control?: Anthropic.Beta.Messages.BetaCacheControlEphemeral | null;
  }): void {
    if (cacheBreakpointBlock) cacheBreakpointBlock.cache_control = undefined;
    block.cache_control = CACHE_BREAKPOINT;
    cacheBreakpointBlock = block;
  }

  for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
    signal?.throwIfAborted();
    // The last turn has to produce the answer. Without this a run that spent
    // its turns on retries ends with nothing, even with evidence in hand.
    const lastTurn = turn === MAX_TOOL_TURNS - 1;
    const modelSpan = tracer.startSpan("model.turn", "model", {
      parent: parentSpan,
      attributes: { turn },
    });

    let response: Anthropic.Beta.Messages.BetaMessage;
    try {
      response = await client.beta.messages.create(
        {
          ...(SERVER_FALLBACK_MODELS.has(model)
            ? { betas: [SERVER_FALLBACK_BETA], fallbacks: "default" as const }
            : {}),
          model,
          max_tokens: MAX_TOKENS,
          system,
          tools: TOOLS_WITH_CACHE,
          ...(lastTurn ? { tool_choice: { type: "none" as const } } : {}),
          messages,
        },
        { signal },
      );
    } catch (err) {
      // An abort surfaces here as the SDK's own error; the signal's reason says
      // why it happened (a deadline, a disconnected client).
      if (signal?.aborted) {
        const reason = signal.reason as Error;
        modelSpan.end("error", {
          category: categorizeError(reason.message),
          message: truncateErrorMessage(reason.message),
        });
        throw reason;
      }
      const message = (err as Error).message;
      modelSpan.end("error", {
        category: "model_api",
        message: truncateErrorMessage(message),
      });
      throw err;
    }

    modelSpan.setAttribute("model", response.model);
    modelSpan.setAttribute("stopReason", response.stop_reason ?? "unknown");
    modelSpan.setAttribute("inputTokens", response.usage.input_tokens);
    modelSpan.setAttribute("outputTokens", response.usage.output_tokens);
    modelSpan.setAttribute(
      "cacheCreationInputTokens",
      response.usage.cache_creation_input_tokens,
    );
    modelSpan.setAttribute(
      "cacheReadInputTokens",
      response.usage.cache_read_input_tokens,
    );
    modelSpan.end("ok");

    // Only what the serving model produced counts, for this turn and for what's
    // sent back.
    const content = afterLastFallback(response.content);
    messages.push({ role: "assistant", content });

    const toolUses = content.filter(
      (block): block is Anthropic.Beta.Messages.BetaToolUseBlock =>
        block.type === "tool_use",
    );

    if (response.stop_reason === "refusal") {
      throw new Error(`${INCOMPLETE_ANSWER_PREFIX} (stop_reason=refusal).`);
    }

    if (toolUses.length === 0) {
      // Allowlist, not denylist: a stop reason this loop doesn't know about
      // must never be presented as a finished answer.
      if (
        response.stop_reason !== "end_turn" &&
        response.stop_reason !== "stop_sequence"
      ) {
        throw new Error(
          `${INCOMPLETE_ANSWER_PREFIX} (stop_reason=${response.stop_reason ?? "unknown"}).`,
        );
      }
      const answer = content
        .filter(
          (block): block is Anthropic.Beta.Messages.BetaTextBlock =>
            block.type === "text",
        )
        .map((block) => block.text)
        .join("\n")
        .trim();
      if (!answer && !assessmentState.current) {
        throw new Error(`${INCOMPLETE_ANSWER_PREFIX} (empty response).`);
      }
      return {
        answer,
        evidence: dedupeEvidence(evidence),
        trace,
        proposedAction: proposalState.current,
        assessment: assessmentState.current,
      };
    }

    // A tool_use block on a truncated turn can carry well-formed but cut-off
    // input (a proposal description ending mid-sentence), so it must not run.
    // Every tool_use still needs a tool_result, and the error lets the model
    // retry with shorter input within the same run.
    const turnComplete = response.stop_reason === "tool_use";
    const toolResults: Anthropic.Beta.Messages.BetaToolResultBlockParam[] = [];
    for (const call of toolUses) {
      const toolSpan = tracer.startSpan(`tool.${call.name}`, "tool", {
        parent: modelSpan,
        attributes: {
          toolName: call.name,
          ...toolCallAttributes(
            call.name,
            call.input as Record<string, unknown>,
          ),
        },
      });
      const start = Date.now();
      try {
        if (!turnComplete) {
          throw new Error(
            `Tool call not executed: the response stopped early (stop_reason=${response.stop_reason ?? "unknown"}), so its input may be incomplete. Retry with shorter input.`,
          );
        }
        const result = await bounded(
          executeTool(
            call.name,
            call.input as Record<string, unknown>,
            deps,
            proposalState,
            assessmentState,
            // Live reference, not a snapshot: reflects everything gathered
            // strictly before this call, including earlier in this same
            // model turn (evidence.push below mutates in place as each
            // call completes).
            evidence,
          ),
          {
            timeoutMs: TOOL_TIMEOUT_MS,
            signal,
            message: `Tool "${call.name}" timed out after ${TOOL_TIMEOUT_MS}ms.`,
          },
        );
        const durationMs = Date.now() - start;
        evidence.push(...result.evidence);
        toolResults.push({
          type: "tool_result",
          tool_use_id: call.id,
          content: JSON.stringify(result.data),
        });
        trace.push({
          tool: call.name,
          input: call.input,
          ok: true,
          durationMs,
        });
        toolSpan.setAttribute("evidenceCount", result.evidence.length);
        for (const [key, value] of Object.entries(
          result.traceAttributes ?? {},
        )) {
          toolSpan.setAttribute(key, value);
        }
        toolSpan.end("ok");
      } catch (err) {
        const durationMs = Date.now() - start;
        const message = (err as Error).message;
        toolResults.push({
          type: "tool_result",
          tool_use_id: call.id,
          content: message,
          is_error: true,
        });
        trace.push({
          tool: call.name,
          input: call.input,
          ok: false,
          durationMs,
          error: message,
        });
        toolSpan.end("error", {
          category: categorizeError(message),
          message: truncateErrorMessage(message),
        });
      }
    }

    moveCacheBreakpoint(toolResults[toolResults.length - 1]!);
    const nextTurnIsLast = turn === MAX_TOOL_TURNS - 2;
    messages.push({
      role: "user",
      content: nextTurnIsLast
        ? [
            ...toolResults,
            {
              type: "text",
              text: "You have used all your tool calls. Give your final answer now from the evidence you have, and say plainly what you couldn't retrieve or complete.",
            },
          ]
        : toolResults,
    });
  }

  throw new Error(
    `Investigation exceeded ${MAX_TOOL_TURNS} tool-use turns without a final answer.`,
  );
}
