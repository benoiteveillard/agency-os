import type { Evidence } from "./types.js";

const DAY_MS = 86_400_000;
const MONTH = new Intl.DateTimeFormat("en-US", {
  month: "short",
  timeZone: "UTC",
});

/** "12 Sep 2026", in UTC so a date doesn't shift with the viewer's timezone. */
function display(date: Date): string {
  return `${date.getUTCDate()} ${MONTH.format(date)} ${date.getUTCFullYear()}`;
}

function parse(timestamp: string | undefined): Date | undefined {
  if (!timestamp) return undefined;
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export function formatDate(timestamp: string | undefined): string | undefined {
  const date = parse(timestamp);
  return date ? display(date) : undefined;
}

/**
 * How fresh the run's evidence is, so old data isn't read as the current state.
 * Undefined when nothing retrieved carries a date: unknown is not "recent".
 */
export function newestEvidenceLabel(
  evidence: Evidence[],
  now: number = Date.now(),
): string | undefined {
  const times = evidence.flatMap((item) => {
    const date = parse(item.timestamp);
    return date ? [date.getTime()] : [];
  });
  if (times.length === 0) return undefined;
  const newest = Math.max(...times);
  const days = Math.max(0, Math.floor((now - newest) / DAY_MS));
  const age =
    days === 0 ? "today" : days === 1 ? "1 day old" : `${days} days old`;
  return `${display(new Date(newest))}, ${age}`;
}
