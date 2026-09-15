import { JsonTraceSerializer } from "@opentelemetry/otlp-transformer";
import type { SpanRecord } from "@agency-os/observability";
import { toReadableSpan } from "./map-span.js";
import { loadExportConfig } from "./config.js";

const DEFAULT_TIMEOUT_MS = 5000;

export interface ExportResult {
  /** False when export is disabled or nothing was sent — never a failure by itself. */
  attempted: boolean;
  ok: boolean;
  error?: string;
}

/**
 * Best-effort OTLP/HTTP export of an already-completed trace. Never
 * throws: a disabled config, a misconfiguration, a network failure, or a
 * non-2xx response all resolve to a returned ExportResult the caller can
 * log — never an exception that could turn a successful investigation
 * into a failed one. Local JSONL (written by the caller before this is
 * ever invoked) remains the source of truth regardless of this result.
 *
 * Only exports RunSummary-level data that's already a scalar span
 * attribute today (e.g. the truncated `question` on the root agent.run
 * span, added in Phase 4) — never `finalAnswer`, which is raw model text
 * and was deliberately kept out of span attributes from the start
 * (packages/observability/src/format.ts). This function only ever touches
 * `SpanRecord[]`, never `RunSummary`, for exactly that reason.
 */
export async function exportTrace(spans: SpanRecord[]): Promise<ExportResult> {
  let config;
  try {
    config = loadExportConfig();
  } catch (err) {
    return { attempted: false, ok: false, error: (err as Error).message };
  }
  if (!config) return { attempted: false, ok: true };

  const readableSpans = spans
    .map(toReadableSpan)
    .filter((s): s is NonNullable<typeof s> => s !== null);
  if (readableSpans.length === 0) return { attempted: false, ok: true };

  const body = JsonTraceSerializer.serializeRequest(readableSpans);
  if (!body) {
    return {
      attempted: true,
      ok: false,
      error: "OTLP serialization produced no output",
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch(config.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...config.headers },
      body,
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return {
        attempted: true,
        ok: false,
        error: `OTLP export failed: HTTP ${response.status} ${text}`.slice(
          0,
          300,
        ),
      };
    }
    return { attempted: true, ok: true };
  } catch (err) {
    return { attempted: true, ok: false, error: (err as Error).message };
  } finally {
    clearTimeout(timeout);
  }
}
