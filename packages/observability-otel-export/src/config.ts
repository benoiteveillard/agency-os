export interface ExportConfig {
  endpoint: string;
  headers: Record<string, string>;
}

/**
 * OTEL_EXPORTER_OTLP_HEADERS format per the OTel spec: comma-separated
 * key=value pairs (W3C-Baggage-inspired), e.g.
 * "Authorization=Basic dXNlcjpwYXNz". Split each pair on the FIRST "="
 * only — not a global split — since a Basic-auth base64 value itself
 * legitimately contains "=" as padding. No percent-decoding: Grafana
 * Cloud's own docs hand you the header value to paste verbatim, so
 * decoding it would corrupt a literal copy-paste value rather than help it.
 */
function parseOtlpHeaders(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  const headers: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    const key = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (key) headers[key] = value;
  }
  return headers;
}

function resolveTracesEndpoint(): string | undefined {
  const tracesSpecific = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  if (tracesSpecific) return tracesSpecific;
  const base = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!base) return undefined;
  // Standard OTel behavior: the base endpoint gets /v1/traces appended for
  // the traces signal specifically.
  return `${base.replace(/\/$/, "")}/v1/traces`;
}

/**
 * Returns null when export is disabled (OTEL_EXPORT_ENABLED unset/not
 * "true") — the default, and the only state local dev/evals ever run in.
 * This explicit application-level flag exists so that merely having
 * OTEL_EXPORTER_OTLP_ENDPOINT set in a shell (e.g. inherited from an
 * unrelated tool) can never silently turn export on.
 *
 * Throws only when explicitly enabled but genuinely misconfigured (no
 * endpoint resolvable) — the caller (exportTrace) always catches this and
 * turns it into a logged warning, never an exception that reaches the
 * agent's own control flow.
 */
export function loadExportConfig(): ExportConfig | null {
  if (process.env.OTEL_EXPORT_ENABLED !== "true") return null;

  const endpoint = resolveTracesEndpoint();
  if (!endpoint) {
    throw new Error(
      "OTEL_EXPORT_ENABLED=true but neither OTEL_EXPORTER_OTLP_TRACES_ENDPOINT nor OTEL_EXPORTER_OTLP_ENDPOINT is set",
    );
  }

  return {
    endpoint,
    headers: parseOtlpHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS),
  };
}
