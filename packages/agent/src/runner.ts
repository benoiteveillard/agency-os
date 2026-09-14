import Anthropic from "@anthropic-ai/sdk";
import type {
  Evidence,
  InvestigationResult,
  ToolCallRecord,
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
} from "./tools.js";
import { buildSystemPrompt } from "./prompts.js";
import { toolCallAttributes } from "./trace-attributes.js";

const DEFAULT_MODEL = "claude-sonnet-5";
const MAX_TOKENS = 4096;
// Safety cap on the tool-use loop so a confused model can't run forever.
const MAX_TOOL_TURNS = 8;

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

export interface InvestigateOptions {
  anthropicApiKey: string;
  model?: string;
  /** The whole CLI lifecycle (investigation + approval + execution) is one trace — see apps/cli/src/index.ts, which owns the tracer and the agent.run root span. */
  tracer: Tracer;
  parentSpan: Span;
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
  const client = new Anthropic({ apiKey: options.anthropicApiKey });
  const model = options.model ?? DEFAULT_MODEL;
  const { tracer, parentSpan } = options;
  const system = buildSystemPrompt(deps.projectRegistry);

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: question },
  ];
  const evidence: Evidence[] = [];
  const trace: ToolCallRecord[] = [];
  // Fresh per investigate() call — never part of AgentDependencies, which
  // is constructed once and shouldn't carry per-run mutable state.
  const proposalState: ProposalState = {};

  for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
    const modelSpan = tracer.startSpan("model.turn", "model", {
      parent: parentSpan,
      attributes: { turn },
    });

    let response: Anthropic.Message;
    try {
      response = await client.messages.create({
        model,
        max_tokens: MAX_TOKENS,
        system,
        tools: TOOLS,
        messages,
      });
    } catch (err) {
      const message = (err as Error).message;
      modelSpan.end("error", {
        category: "model_api",
        message: truncateErrorMessage(message),
      });
      throw err;
    }

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

    messages.push({ role: "assistant", content: response.content });

    const toolUses = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
    );

    if (toolUses.length === 0) {
      const answer = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim();
      return {
        answer,
        evidence: dedupeEvidence(evidence),
        trace,
        proposedAction: proposalState.current,
      };
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
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
        const result = await executeTool(
          call.name,
          call.input as Record<string, unknown>,
          deps,
          proposalState,
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

    messages.push({ role: "user", content: toolResults });
  }

  throw new Error(
    `Investigation exceeded ${MAX_TOOL_TURNS} tool-use turns without a final answer.`,
  );
}
