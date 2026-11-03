import { useState } from "react";
import type { InvestigationMetadata } from "../types.js";
import { Icon } from "./Icon.js";

function formatTokens(n: number | undefined): string | undefined {
  if (n === undefined) return undefined;
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export function MetadataFooter({
  metadata,
}: {
  metadata: InvestigationMetadata;
}) {
  const [copyLabel, setCopyLabel] = useState("Copy trace ID");
  const inputTokens = formatTokens(metadata.inputTokens);
  const outputTokens = formatTokens(metadata.outputTokens);

  async function copyTraceId() {
    try {
      await navigator.clipboard.writeText(metadata.traceId);
      setCopyLabel("Copied");
    } catch {
      // Clipboard access can fail (permissions, insecure context); the trace
      // ID is still on screen to select by hand.
      setCopyLabel("Select the ID to copy it");
    }
    setTimeout(() => setCopyLabel("Copy trace ID"), 1500);
  }

  return (
    <details className="disclosure-panel">
      <summary>
        Run details
        <Icon name="CaretDown" />
      </summary>
      <dl className="metadata">
        <div>
          <dt>Duration</dt>
          <dd>{(metadata.durationMs / 1000).toFixed(1)}s</dd>
        </div>
        <div>
          <dt>Tool calls</dt>
          <dd>{metadata.toolCallCount}</dd>
        </div>
        {inputTokens && (
          <div>
            <dt>Input tokens</dt>
            <dd>{inputTokens}</dd>
          </div>
        )}
        {outputTokens && (
          <div>
            <dt>Output tokens</dt>
            <dd>{outputTokens}</dd>
          </div>
        )}
      </dl>
      <div className="trace">
        <code>{metadata.traceId}</code>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={copyTraceId}
        >
          {copyLabel}
        </button>
      </div>
    </details>
  );
}
