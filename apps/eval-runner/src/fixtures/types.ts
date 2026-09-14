/**
 * A scenario declares each fixture-backed method's canned result as an
 * explicit ok/throw outcome — never a value the fake infers or defaults.
 * This is how failure-injection scenarios (write API failure, read-back
 * failure, tool errors) are expressed purely as data, with no special-case
 * code in the fixture classes themselves.
 */
export type FixtureOutcome<T> =
  { ok: true; value: T } | { ok: false; error: string };
