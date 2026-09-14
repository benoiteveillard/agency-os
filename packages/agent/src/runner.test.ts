import { describe, expect, it } from "vitest";
import type { Evidence } from "@agency-os/shared";
import { dedupeEvidence } from "./runner.js";

function evidence(
  source: Evidence["source"],
  id: string,
  summary = "x",
): Evidence {
  return { source, id, summary };
}

describe("dedupeEvidence", () => {
  it("drops a later duplicate with the same source and id, keeping the first", () => {
    const result = dedupeEvidence([
      evidence("slack", "1726142400.000100", "root, from channel history"),
      evidence("slack", "1726142400.000100", "root, from thread"),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]?.summary).toBe("root, from channel history");
  });

  it("keeps entries with the same id but a different source — id is only unique per source", () => {
    const result = dedupeEvidence([
      evidence("linear", "1"),
      evidence("github", "1"),
    ]);

    expect(result).toHaveLength(2);
  });

  it("keeps distinct ids from the same source", () => {
    const result = dedupeEvidence([
      evidence("slack", "1"),
      evidence("slack", "2"),
    ]);

    expect(result).toHaveLength(2);
  });

  it("is a no-op on an empty list", () => {
    expect(dedupeEvidence([])).toEqual([]);
  });
});
