import { describe, expect, it } from "vitest";
import { generateSpanId, generateTraceId } from "./ids.js";

describe("generateTraceId", () => {
  it("produces a 32-character hex string (128 bits — W3C/OTel trace-id width)", () => {
    expect(generateTraceId()).toMatch(/^[0-9a-f]{32}$/);
  });

  it("is unique across calls", () => {
    expect(generateTraceId()).not.toBe(generateTraceId());
  });
});

describe("generateSpanId", () => {
  it("produces a 16-character hex string (64 bits — W3C/OTel span-id width)", () => {
    expect(generateSpanId()).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is unique across calls", () => {
    expect(generateSpanId()).not.toBe(generateSpanId());
  });
});
