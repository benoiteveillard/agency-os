import { randomBytes } from "node:crypto";

/**
 * 16 bytes = 128 bits = 32 hex chars — the exact width of a W3C Trace
 * Context / OpenTelemetry trace-id. Using node:crypto directly, not the
 * OpenTelemetry SDK, since generating a correctly-sized random ID doesn't
 * need a tracing library — but the width match means these IDs are
 * already interchangeable with OTel's own format when an exporter is
 * added later, with no reformatting step.
 */
export function generateTraceId(): string {
  return randomBytes(16).toString("hex");
}

/** 8 bytes = 64 bits = 16 hex chars — the exact width of an OTel span-id. */
export function generateSpanId(): string {
  return randomBytes(8).toString("hex");
}
