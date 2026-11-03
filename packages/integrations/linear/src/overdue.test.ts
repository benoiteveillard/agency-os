import { describe, expect, it } from "vitest";
import { isOverdue } from "./overdue.js";

describe("isOverdue", () => {
  const now = new Date("2026-09-12T00:00:00Z");

  it("is false when there is no due date", () => {
    expect(isOverdue(null, "started", now)).toBe(false);
  });

  it("is true when the due date is in the past and the issue is still open", () => {
    expect(isOverdue("2026-09-01", "started", now)).toBe(true);
  });

  it("is false for the whole of its due day, at any UTC hour", () => {
    expect(
      isOverdue("2026-09-12", "started", new Date("2026-09-12T00:00:00Z")),
    ).toBe(false);
    expect(
      isOverdue("2026-09-12", "started", new Date("2026-09-12T23:59:59Z")),
    ).toBe(false);
  });

  it("is true from the day after the due date", () => {
    expect(
      isOverdue("2026-09-12", "started", new Date("2026-09-13T00:00:00Z")),
    ).toBe(true);
  });

  it("is false when the due date is in the future", () => {
    expect(isOverdue("2026-12-01", "started", now)).toBe(false);
  });

  it("is false once the issue is completed, even if overdue", () => {
    expect(isOverdue("2026-09-01", "completed", now)).toBe(false);
  });

  it("is false once the issue is canceled, even if overdue", () => {
    expect(isOverdue("2026-09-01", "canceled", now)).toBe(false);
  });
});
