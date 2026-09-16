import { useState } from "react";
import type { InvestigationMetadata } from "../types.js";

function formatTokens(n: number | undefined): string | undefined {
  if (n === undefined) return undefined;
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export function MetadataFooter({
  metadata,
}: {
  metadata: InvestigationMetadata;
}) {
  const [copied, setCopied] = useState(false);
  const inputTokens = formatTokens(metadata.inputTokens);
  const outputTokens = formatTokens(metadata.outputTokens);

  async function copyTraceId() {
    try {
      await navigator.clipboard.writeText(metadata.traceId);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can fail silently (permissions, insecure context);
      // the trace ID is still visible as text to select manually.
    }
  }

  return (
    <details className="run-details">
      <summary>
        Investigation details <span>Duration, usage & trace</span>
      </summary>
      <section className="metadata" aria-label="Investigation details">
        <dl className="metadata__item">
          <dt>Duration</dt>
          <dd>{(metadata.durationMs / 1000).toFixed(1)}s</dd>
        </dl>
        <dl className="metadata__item">
          <dt>Tool calls</dt>
          <dd>{metadata.toolCallCount}</dd>
        </dl>
        {inputTokens && (
          <dl className="metadata__item">
            <dt>Input tokens</dt>
            <dd>{inputTokens}</dd>
          </dl>
        )}
        {outputTokens && (
          <dl className="metadata__item">
            <dt>Output tokens</dt>
            <dd>{outputTokens}</dd>
          </dl>
        )}
        <div className="metadata__trace">
          <dl className="metadata__item">
            <dt>Trace</dt>
            <dd>{metadata.traceId}</dd>
          </dl>
          <button type="button" className="copy-btn" onClick={copyTraceId}>
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </section>
    </details>
  );
}
