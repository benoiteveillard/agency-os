import { describe, expect, it } from "vitest";
import { hasNextPage } from "./pull-request-source.js";

describe("hasNextPage", () => {
  it("is true only when GitHub's Link header names a next page", () => {
    expect(
      hasNextPage(
        '<https://api.github.com/repositories/1/pulls?page=2>; rel="next", <https://api.github.com/repositories/1/pulls?page=3>; rel="last"',
      ),
    ).toBe(true);
    expect(
      hasNextPage(
        '<https://api.github.com/repositories/1/pulls?page=1>; rel="prev"',
      ),
    ).toBe(false);
    expect(hasNextPage(undefined)).toBe(false);
  });
});
