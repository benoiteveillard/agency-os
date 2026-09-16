import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { bodyLimit } from "hono/body-limit";
import { investigate, reviewAndExecute } from "@agency-os/agent";
import {
  categorizeError,
  truncateErrorMessage,
  Tracer,
  type SpanRecord,
} from "@agency-os/observability";
import {
  createProductionRuntime,
  type ProductionRuntime,
} from "@agency-os/runtime";
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
  onTrace?: (spans: SpanRecord[]) => Promise<void>;
  pollMs?: number;
  /**
   * Phase 7.4: smallest reasonable protection against a public demo
   * burning paid Anthropic credits — a global in-process cap on
   * concurrently running investigations, not per-IP/per-user (no auth,
   * no Redis, no database; this is a single-replica portfolio demo, see
   * docs/decisions.md "Phase 7.4"). Defaults to
   * MAX_CONCURRENT_INVESTIGATIONS, or 1 if unset.
   */
  maxConcurrentInvestigations?: number;
}
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

export function createWebApp(options: WebOptions = {}) {
  const app = new Hono();
  const factory = options.createRuntime ?? createProductionRuntime;
  const runInvestigation = options.investigate ?? investigate;
  const store = options.store ?? new ProposalStore();
  const maxConcurrentInvestigations =
    options.maxConcurrentInvestigations ??
    Number(process.env.MAX_CONCURRENT_INVESTIGATIONS ?? "1");
  let activeInvestigations = 0;
  const publish = (tracer: Tracer) => {
    // Independent of HTTP delivery, including disconnected clients. Catch sync and async failures.
    void Promise.resolve()
      .then(() => options.onTrace?.(tracer.getSpans()))
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
        const root = tracer.startSpan("agent.run", "run");
        const startedAt = Date.now();
        const mapper = new ProgressMapper();
        let disconnected = false;
        stream.onAbort(() => {
          disconnected = true;
        });
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
            runtime = await factory();
            const result = await runInvestigation(
              question.trim(),
              runtime.dependencies,
              {
                anthropicApiKey: runtime.anthropicApiKey,
                tracer,
                parentSpan: root,
              },
            );
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
            const message = (err as Error).message;
            console.error(
              JSON.stringify({
                event: "investigation.failed",
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
            publish(tracer);
          }
        })().finally(() => {
          settled = true;
          activeInvestigations--;
        });
        while (!settled && !disconnected) {
          for (const event of mapper.poll(tracer.getSpans()))
            await send(event.event, event.data);
          await new Promise((resolve) =>
            setTimeout(resolve, options.pollMs ?? 50),
          );
        }
        const result = await task;
        for (const event of mapper.poll(tracer.getSpans()))
          await send(event.event, event.data);
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
          let runtime: ProductionRuntime | undefined;
          let ok = false;
          try {
            runtime = await factory();
            const result = await reviewAndExecute(action, {
              promptForApproval: async () => decision === "approve",
              issueWriter: runtime.issueWriter,
              issueTracker: runtime.dependencies.issueTracker,
              tracer,
              parentSpan: root,
              // Server-owned, never client-controlled: set only via this
              // process's own environment. See docs/decisions.md "Phase
              // 7.4" for why a public demo can't expose unrestricted real
              // writes.
              writesEnabled: process.env.DEMO_WRITE_MODE !== "disabled",
            });
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
            publish(tracer);
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
