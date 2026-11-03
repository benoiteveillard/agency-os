const CLOSED_STATE_TYPES = new Set(["completed", "canceled"]);

/**
 * An issue is overdue if its due date is before today and it hasn't reached a
 * closed workflow state. Due dates are calendar days (Linear's TimelessDate,
 * YYYY-MM-DD), so an issue due today isn't late yet. Parsing one with `new
 * Date` gives midnight UTC, which would flag it as overdue for all of its due
 * day; comparing date strings avoids that. "Today" is the UTC date, the same
 * date the system prompt gives the model. Pulled out as a pure function so it
 * can be unit tested without constructing real @linear/sdk model instances.
 */
export function isOverdue(
  dueDate: string | null,
  stateType: string,
  now: Date = new Date(),
): boolean {
  if (!dueDate) return false;
  if (CLOSED_STATE_TYPES.has(stateType)) return false;
  return dueDate.slice(0, 10) < now.toISOString().slice(0, 10);
}
