import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { bodyLimit } from "hono/body-limit";
import {
  investigate,
  reviewAndExecute,
  type AnswerTextUpdate,
  type ReviewAndExecuteDeps,
} from "@agency-os/agent";
import {
  categorizeError,
  truncateErrorMessage,
  Tracer,
  type RunSummary,
  type SpanRecord,
} from "@agency-os/observability";
import {
  createProductionRuntime,
  type ProductionRuntime,
} from "@agency-os/runtime";
import { bounded, type AuditLog } from "@agency-os/shared";
import { ProposalStore, ProposalStoreError } from "./proposal-store.js";
import { ProgressMapper } from "./progress.js";
import {
  presentAudit,
  presentProposal,
  presentResult,
} from "./presentation.js";

export interface WebOptions {
  createRuntime?: () => Promise<ProductionRuntime>;
  investigate?: typeof investigate;
  store?: ProposalStore;
  /** Called with a completed trace. Must not gate the HTTP result. */
  onTrace?: (
    spans: SpanRecord[],
    summary: Omit<RunSummary, "traceId">,
  ) => Promise<void>;
  /**
   * Durable record of every decision. A decision that can't be recorded isn't
   * executed; a result that can't be recorded is logged, since the write has
   * already happened by then.
   */
  auditLog?: AuditLog;
  pollMs?: number;
  /**
   * Phase 7.4: smallest reasonable protection against a public demo
   * burning paid Anthropic credits — a global in-process cap on
   * concurrently running investigations, not per-IP/per-user (no auth,
   * no Redis, no database; this is a single-replica portfolio demo, see
   * docs/decisions.md "Phase 7.4"). Defaults to
   * MAX_CONCURRENT_INVESTIGATIONS, or 1 if unset. Anything but a positive
   * integer refuses to start, since an unparseable value would otherwise
   * remove the cap.
   */
  maxConcurrentInvestigations?: number;
  /**
   * Hard limit on one investigation, so a stuck run can't hold the only
   * concurrency slot. Defaults to INVESTIGATION_TIMEOUT_MS, or 4 minutes
   * (the slowest recorded live run took about 93 seconds).
   */
  investigationTimeoutMs?: number;
  /** Limit on starting a runtime for an approved write. Overridable for tests. */
  runtimeStartTimeoutMs?: number;
}
const DEFAULT_INVESTIGATION_TIMEOUT_MS = 240_000;
const RUNTIME_START_TIMEOUT_MS = 30_000;
const INVALID = {
  error: {
    code: "invalid_request",
    message: "Expected a JSON object with exactly the documented field.",
  },
};
async function body(c: Context, field: string): Promise<unknown> {
  if (
    c.req.header("content-type")?.split(";")[0]?.trim().toLowerCase() !==
    "application/json"
  )
    return undefined;
  try {
    const value: unknown = await c.req.json();
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).length !== 1 ||
      !(field in value)
    )
      return undefined;
    return (value as Record<string, unknown>)[field];
  } catch {
    return undefined;
  }
}

/** Refuses to start on anything but a positive integer, rather than running unbounded. */
function resolvePositiveInt(
  name: string,
  explicit: number | undefined,
  fallback: number,
): number {
  const value = explicit ?? Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Invalid ${name}: expected a positive integer.`);
  }
  return value;
}

/**
 * Real external writes are opt-in: only the exact value "enabled" allows them,
 * so an unset or mistyped variable fails closed. Server-owned, never
 * client-controlled. See docs/decisions.md.
 */
function writesEnabled(): boolean {
  return process.env.DEMO_WRITE_MODE === "enabled";
}

/**
 * Stands in for the write and read-back ports when a decision can't reach them
 * (a rejection, or an approval with writes disabled), so those decisions don't
 * need a runtime, its credentials or an MCP process. Throwing keeps any future
 * path that does reach them from passing silently.
 */
const UNREACHABLE_DECISION_PORTS: Pick<
  ReviewAndExecuteDeps,
  "issueWriter" | "issueTracker"
> = {
  issueWriter: {
    createIssue: async () => {
      throw new Error("Writes are not available for this decision.");
    },
  },
  issueTracker: {
    listProjectIssues: async () => {
      throw new Error("Reads are not available for this decision.");
    },
    getIssue: async () => {
      throw new Error("Reads are not available for this decision.");
    },
  },
};

export function createWebApp(options: WebOptions = {}) {
  const app = new Hono();
  const factory =
    options.createRuntime ??
    (() => createProductionRuntime({ writesEnabled: writesEnabled() }));
  const runInvestigation = options.investigate ?? investigate;
  const store = options.store ?? new ProposalStore();
  const maxConcurrentInvestigations = resolvePositiveInt(
    "MAX_CONCURRENT_INVESTIGATIONS",
    options.maxConcurrentInvestigations,
    1,
  );
  const investigationTimeoutMs = resolvePositiveInt(
    "INVESTIGATION_TIMEOUT_MS",
    options.investigationTimeoutMs,
    DEFAULT_INVESTIGATION_TIMEOUT_MS,
  );
  // Stops waiting for a runtime that's slow to start, and closes it if it does
  // turn up later, so a late MCP process isn't left running.
  const startRuntime = (limits: {
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<ProductionRuntime> => {
    const starting = factory();
    return bounded(starting, {
      ...limits,
      message: "Runtime start timed out.",
    }).catch((error: unknown) => {
      void starting.then((late) => late.close()).catch(() => {});
      throw error;
    });
  };
  let activeInvestigations = 0;
  const publish = (
    tracer: Tracer,
    root: { question: string; finalAnswer: string },
  ) => {
    const resultMetadata = {
      ...tracer.getSpans().find((span) => !span.parentSpanId)?.attributes,
    };
    // Independent of HTTP delivery, including disconnected clients. Catch sync and async failures.
    void Promise.resolve()
      .then(() =>
        options.onTrace?.(tracer.getSpans(), { ...root, resultMetadata }),
      )
      .catch(() => {
        console.error(
          JSON.stringify({
            event: "trace.persistence_failed",
            traceId: tracer.traceId,
          }),
        );
      });
  };
  app.onError(
    () =>
      new Response(
        JSON.stringify({
          error: { code: "internal_error", message: "Request failed." },
        }),
        { status: 500, headers: { "content-type": "application/json" } },
      ),
  );
  app.use("/api/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
    // JSON-only endpoints plus same-origin browser requests; no credentialed CORS.
    const origin = c.req.header("origin");
    // Behind a TLS-terminating reverse proxy (Railway, and virtually every
    // PaaS/CDN), the connection this process actually sees is plain HTTP
    // even though the browser's real, externally-visible origin is
    // https — c.req.url's own scheme reflects that internal hop, not
    // what the browser sent, and comparing it directly against a real
    // browser's Origin header always mismatches in production. The Host
    // header itself is already correct (proxies forward it unchanged for
    // routing). Trusting X-Forwarded-Proto here doesn't weaken this
    // check: it's set only by Railway's own edge, which is the only path
    // that can reach this process — nothing else is exposed to the
    // public internet to spoof it.
    const forwardedProto = c.req
      .header("x-forwarded-proto")
      ?.split(",")[0]
      ?.trim();
    const requestUrl = new URL(c.req.url);
    const effectiveOrigin = forwardedProto
      ? `${forwardedProto}://${requestUrl.host}`
      : requestUrl.origin;
    if (
      (origin && origin !== effectiveOrigin) ||
      c.req.header("sec-fetch-site") === "cross-site"
    ) {
      return c.json(
        {
          error: {
            code: "invalid_request",
            message: "Cross-origin requests are not supported.",
          },
        },
        403,
      );
    }
    await next();
  });
  app.use(
    "/api/*",
    bodyLimit({ maxSize: 32_768, onError: (c) => c.json(INVALID, 413) }),
  );
  app.get("/health", (c) => c.json({ status: "ok" }));

  app.post("/api/investigate", async (c) => {
    const question = await body(c, "question");
    if (
      typeof question !== "string" ||
      !question.trim() ||
      question.length > 8_000
    )
      return c.json(INVALID, 400);
    if (activeInvestigations >= maxConcurrentInvestigations) {
      return c.json(
        {
          error: {
            code: "demo_busy",
            message:
              "The demo is currently running another investigation. Please try again in a moment.",
          },
        },
        429,
      );
    }
    activeInvestigations++;
    c.header("X-Accel-Buffering", "no");
    const response = streamSSE(
      c,
      async (stream) => {
        const tracer = new Tracer();
        const root = tracer.startSpan("agent.run", "run", {
          attributes: { question: question.trim().slice(0, 200) },
        });
        let finalAnswer = "";
        const startedAt = Date.now();
        const mapper = new ProgressMapper();
        let disconnected = false;
        const cancellation = new AbortController();
        const deadline = setTimeout(
          () =>
            cancellation.abort(
              new Error("Investigation exceeded its deadline."),
            ),
          investigationTimeoutMs,
        );
        // Nobody can read the result or act on its proposal any more, so
        // finishing the run would only spend money and hold the slot.
        stream.onAbort(() => {
          disconnected = true;
          cancellation.abort(
            new Error("Investigation cancelled: client disconnected."),
          );
        });
        // Answer text is buffered and flushed with the progress events, so
        // every SSE write stays on one ordered path and deltas are coalesced
        // per poll instead of one event per token.
        let answerReset = false;
        let answerText = "";
        const onAnswerText = (update: AnswerTextUpdate) => {
          if (update.type === "reset") {
            answerReset = true;
            answerText = "";
          } else {
            answerText += update.text;
          }
        };
        let sequence = 0;
        const send = async (event: string, data: unknown) => {
          if (disconnected) return;
          try {
            await stream.writeSSE({
              event,
              data: JSON.stringify(data),
              id: String(++sequence),
            });
          } catch {
            disconnected = true;
          }
        };
        await send("investigation.started", { traceId: tracer.traceId });
        // Execution and cleanup do not depend on a reader consuming the stream.
        let settled = false;
        const task = (async () => {
          let runtime: ProductionRuntime | undefined;
          let ok = false;
          try {
            runtime = await startRuntime({ signal: cancellation.signal });
            const result = await runInvestigation(
              question.trim(),
              runtime.dependencies,
              {
                anthropicApiKey: runtime.anthropicApiKey,
                tracer,
                parentSpan: root,
                signal: cancellation.signal,
                onAnswerText,
              },
            );
            cancellation.signal.throwIfAborted();
            finalAnswer = result.answer;
            // Validate/projection before publishing the canonical action in the store.
            const dto = presentResult(
              result,
              tracer.traceId,
              Date.now() - startedAt,
              tracer.getSpans(),
            );
            const proposal = result.proposedAction;
            const presentation = proposal
              ? presentProposal(
                  proposal,
                  store.insert(proposal, tracer.traceId).expiresAt,
                )
              : undefined;
            root.setAttribute("evidenceCount", dto.evidence.length);
            root.setAttribute("toolCallCount", dto.metadata.toolCallCount);
            root.setAttribute("assessmentPresent", !!dto.assessment);
            if (dto.assessment)
              root.setAttribute("assessmentVerdict", dto.assessment.verdict);
            root.setAttribute("proposedAction", !!presentation);
            ok = true;
            return {
              ...dto,
              ...(presentation
                ? { proposedActionPresentation: presentation }
                : {}),
            };
          } catch (err) {
            // Sanitized the same way tool/model errors already are
            // elsewhere (runner.ts, approval.ts) — category + truncated
            // message only, never the raw error (which could echo
            // provider payloads, prompts, or evidence content). Was
            // previously silently swallowed here, which made production
            // failures undiagnosable without live SSH/console access to
            // the process — found running Phase 7.4's own production
            // smoke test.
            const message = (
              (cancellation.signal.aborted
                ? cancellation.signal.reason
                : err) as Error
            ).message;
            console.error(
              JSON.stringify({
                event: disconnected
                  ? "investigation.cancelled"
                  : "investigation.failed",
                traceId: tracer.traceId,
                category: categorizeError(message),
                message: truncateErrorMessage(message),
              }),
            );
            return undefined;
          } finally {
            root.end(ok ? "ok" : "error");
            try {
              await runtime?.close();
            } catch {
              console.error(
                JSON.stringify({
                  event: "runtime.close_failed",
                  traceId: tracer.traceId,
                }),
              );
            }
            publish(tracer, { question: question.trim(), finalAnswer });
          }
        })().finally(() => {
          clearTimeout(deadline);
          settled = true;
          activeInvestigations--;
        });
        const flush = async () => {
          for (const event of mapper.poll(tracer.getSpans()))
            await send(event.event, event.data);
          if (answerReset) {
            answerReset = false;
            await send("answer.reset", {});
          }
          if (answerText) {
            const text = answerText;
            answerText = "";
            await send("answer.delta", { text });
          }
        };
        while (!settled && !disconnected) {
          await flush();
          await new Promise((resolve) =>
            setTimeout(resolve, options.pollMs ?? 50),
          );
        }
        const result = await task;
        await flush();
        if (!result) {
          await send("investigation.failed", {
            error: {
              code: "investigation_failed",
              message: "Investigation failed. Please try again.",
            },
            traceId: tracer.traceId,
          });
          return;
        }
        if (result.assessment)
          await send("assessment.ready", {
            verdict: result.assessment.verdict,
            blockerCount: result.assessment.blockers.length,
          });
        if (result.proposedActionPresentation)
          await send("action.proposed", result.proposedActionPresentation);
        await send("investigation.completed", result);
      },
      async (error, stream) => {
        // Hono emits error.message after this callback, so sanitize it as well.
        error.message = "Investigation failed.";
        await stream.writeSSE({
          event: "investigation.failed",
          data: JSON.stringify({
            error: { code: "investigation_failed", message: error.message },
          }),
        });
        stream.abort();
      },
    );
    response.headers.set("Cache-Control", "no-store");
    return response;
  });

  app.post("/api/proposals/:proposalId/decide", async (c) => {
    const decision = await body(c, "decision");
    if (decision !== "approve" && decision !== "reject")
      return c.json(INVALID, 400);
    try {
      const audit = await store.decide(
        c.req.param("proposalId"),
        decision,
        async (action, investigationTraceId) => {
          const tracer = new Tracer();
          const root = tracer.startSpan("web.approval", "run", {
            attributes: { proposalId: action.id, investigationTraceId },
          });
          const auditContext = {
            investigationTraceId,
            approvalTraceId: tracer.traceId,
          };
          let runtime: ProductionRuntime | undefined;
          let ok = false;
          try {
            const canWrite = writesEnabled();
            if (decision === "approve" && canWrite) {
              runtime = await startRuntime({
                timeoutMs:
                  options.runtimeStartTimeoutMs ?? RUNTIME_START_TIMEOUT_MS,
              });
            }
            const result = await reviewAndExecute(action, {
              promptForApproval: async (proposal) => {
                await options.auditLog?.append({
                  event: "decision",
                  at: new Date().toISOString(),
                  decision,
                  actor: "anonymous web visitor",
                  proposal,
                  ...auditContext,
                });
                return decision === "approve";
              },
              issueWriter:
                runtime?.issueWriter ?? UNREACHABLE_DECISION_PORTS.issueWriter,
              issueTracker:
                runtime?.dependencies.issueTracker ??
                UNREACHABLE_DECISION_PORTS.issueTracker,
              tracer,
              parentSpan: root,
              writesEnabled: canWrite,
            });
            try {
              await options.auditLog?.append({
                event: "result",
                at: new Date().toISOString(),
                audit: result,
                ...auditContext,
              });
            } catch {
              console.error(
                JSON.stringify({
                  event: "audit.result_write_failed",
                  proposalId: action.id,
                  traceId: tracer.traceId,
                }),
              );
            }
            root.setAttribute("approvalDecision", result.decision);
            if (result.execution)
              root.setAttribute("executionOutcome", result.execution.outcome);
            ok = result.execution?.outcome !== "failure";
            return result;
          } finally {
            root.end(ok ? "ok" : "error");
            try {
              await runtime?.close();
            } catch {
              console.error(
                JSON.stringify({
                  event: "runtime.close_failed",
                  traceId: tracer.traceId,
                }),
              );
            }
            publish(tracer, { question: "", finalAnswer: "" });
          }
        },
      );
      return c.json(
        presentAudit(audit),
        audit.execution?.outcome === "failure" ? 502 : 200,
      );
    } catch (error) {
      const code =
        error instanceof ProposalStoreError
          ? error.code
          : "proposal_execution_failed";
      // Only the attempt that actually failed has a cause; a repeat request
      // for an already-failed proposal has nothing new to report.
      const cause = error instanceof ProposalStoreError ? error.cause : error;
      if (code === "proposal_execution_failed" && cause) {
        const message = (cause as Error).message;
        console.error(
          JSON.stringify({
            event: "proposal.decision_failed",
            proposalId: c.req.param("proposalId"),
            decision,
            category: categorizeError(message),
            message: truncateErrorMessage(message),
          }),
        );
      }
      if (code === "unknown_proposal")
        return c.json(
          {
            error: {
              code: "proposal_not_found",
              message: "Proposal not found.",
            },
          },
          404,
        );
      if (code === "expired_proposal")
        return c.json(
          {
            error: {
              code: "proposal_expired",
              message: "Proposal expired. Start a new investigation.",
            },
          },
          410,
        );
      if (
        code === "proposal_already_decided" ||
        code === "proposal_in_progress"
      )
        return c.json(
          {
            error: {
              code,
              message:
                code === "proposal_in_progress"
                  ? "Decision is in progress. Retry the same decision later."
                  : "Proposal already decided.",
            },
          },
          409,
        );
      return c.json(
        {
          error: {
            code: "execution_failed",
            message: "Decision failed. This proposal will not be retried.",
          },
        },
        502,
      );
    }
  });
  return app;
}
