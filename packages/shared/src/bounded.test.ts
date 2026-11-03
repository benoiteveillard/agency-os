import { describe, expect, it } from "vitest";
import { bounded, TimeoutError } from "./bounded.js";

const never = new Promise<never>(() => {});

describe("bounded", () => {
  it("passes through a result that arrives in time", async () => {
    await expect(
      bounded(Promise.resolve("ok"), { timeoutMs: 1000, message: "late" }),
    ).resolves.toBe("ok");
  });

  it("passes through a failure that arrives in time", async () => {
    await expect(
      bounded(Promise.reject(new Error("boom")), {
        timeoutMs: 1000,
        message: "late",
      }),
    ).rejects.toThrow("boom");
  });

  it("stops waiting with a TimeoutError", async () => {
    const outcome = bounded(never, { timeoutMs: 1, message: "too slow" });
    await expect(outcome).rejects.toBeInstanceOf(TimeoutError);
    await expect(outcome).rejects.toThrow("too slow");
  });

  it("stops waiting when the signal aborts, with the signal's reason", async () => {
    const controller = new AbortController();
    const outcome = bounded(never, {
      signal: controller.signal,
      message: "unused",
    });
    controller.abort(new Error("client left"));
    await expect(outcome).rejects.toThrow("client left");
  });

  it("rejects straight away for an already-aborted signal", async () => {
    await expect(
      bounded(never, {
        signal: AbortSignal.abort(new Error("gone")),
        message: "unused",
      }),
    ).rejects.toThrow("gone");
  });
});
