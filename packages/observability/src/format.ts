import type { AttributeValue, SpanRecord } from "./types.js";

/** Human-readable indented tree for CLI stderr — not the persisted trace file shape (see persist.ts). */
export function formatTraceTree(spans: SpanRecord[]): string {
  const childrenByParent = new Map<string | undefined, SpanRecord[]>();
  for (const span of spans) {
    const list = childrenByParent.get(span.parentSpanId) ?? [];
    list.push(span);
    childrenByParent.set(span.parentSpanId, list);
  }

  const lines: string[] = [];

  function render(span: SpanRecord, depth: number): void {
    const indent = "  ".repeat(depth);
    const duration =
      span.durationMs !== undefined ? `${span.durationMs}ms` : "unfinished";
    const status =
      span.status === "error" ? "ERROR" : span.status.toUpperCase();
    lines.push(`${indent}${span.name} [${status}, ${duration}]`);
    if (span.errorMessage) {
      lines.push(`${indent}  ⤷ ${span.errorCategory}: ${span.errorMessage}`);
    }
    for (const child of childrenByParent.get(span.spanId) ?? []) {
      render(child, depth + 1);
    }
  }

  for (const root of childrenByParent.get(undefined) ?? []) {
    render(root, 0);
  }

  return lines.join("\n");
}

/**
 * The question and final answer, plus scalar-only summary metadata — kept
 * distinct from Evidence[], which is never persisted here (evidence
 * summaries can contain quoted Slack/issue text; this file must not).
 * This is what lets a future eval consume {trace, question, finalAnswer,
 * resultMetadata} without scraping stdout or storing raw tool payloads.
 */
export interface RunSummary {
  traceId: string;
  question: string;
  finalAnswer: string;
  resultMetadata: Record<string, AttributeValue>;
}

/**
 * One JSON object per line: every span record, then one run_summary
 * record. A future eval script reads the file, splits on `type`, and
 * reconstructs {trace: spans, question, finalAnswer, resultMetadata}
 * directly — no stdout scraping.
 */
export function serializeTraceFile(
  spans: SpanRecord[],
  summary: RunSummary,
): string {
  const lines = spans.map((span) =>
    JSON.stringify({ type: "span" as const, ...span }),
  );
  lines.push(JSON.stringify({ type: "run_summary" as const, ...summary }));
  return `${lines.join("\n")}\n`;
}
