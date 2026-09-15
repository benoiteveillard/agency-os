import type { ApiError, AuditDTO, SSEMessage } from "./types.js";

/**
 * The backend's SSE endpoint requires a POST body (the question), so the
 * browser's native EventSource (GET-only) can't be used. Parses the same
 * "event: x\ndata: y\n\n" framing apps/web/src/app.ts writes, incrementally
 * as bytes arrive — never buffering the whole response before yielding.
 */
export async function* streamInvestigation(
  question: string,
  signal?: AbortSignal,
): AsyncGenerator<SSEMessage> {
  const response = await fetch("/api/investigate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question }),
    signal,
  });
  if (!response.ok || !response.body) {
    throw new Error(`Investigation request failed (${response.status})`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const message = parseBlock(block);
        if (message) yield message;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function parseBlock(block: string): SSEMessage | undefined {
  let event: string | undefined;
  let data: string | undefined;
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data = line.slice(5).trim();
  }
  if (!event || data === undefined) return undefined;
  try {
    return { event, data: JSON.parse(data) } as SSEMessage;
  } catch {
    return undefined;
  }
}

export type Decision = "approve" | "reject";

export interface DecideResult {
  ok: true;
  audit: AuditDTO;
  status: number;
}
export interface DecideFailure {
  ok: false;
  error: ApiError;
  status: number;
}

export async function decideProposal(
  proposalId: string,
  decision: Decision,
): Promise<DecideResult | DecideFailure> {
  const response = await fetch(
    `/api/proposals/${encodeURIComponent(proposalId)}/decide`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision }),
    },
  );
  const body: unknown = await response.json().catch(() => undefined);
  // 502 is not enough on its own to tell success-with-failed-execution
  // (presentAudit still returns a full AuditDTO, with the error nested
  // under execution.error) apart from a request-level failure (a top-level
  // {error} envelope) — apps/web/src/app.ts uses 502 for both. Decide by
  // body shape, not status code.
  if (body && typeof body === "object" && "decision" in body) {
    return { ok: true, audit: body as AuditDTO, status: response.status };
  }
  const error =
    body && typeof body === "object" && "error" in body
      ? ((body as { error: ApiError }).error ?? {
          code: "unknown_error",
          message: "The request failed.",
        })
      : { code: "unknown_error", message: "The request failed." };
  return { ok: false, error, status: response.status };
}
