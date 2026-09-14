const CLOSED_STATE_TYPES = new Set(["completed", "canceled"]);

/**
 * An issue is overdue if it has a due date in the past and hasn't reached a
 * closed workflow state. Pulled out as a pure function so it can be unit
 * tested without constructing real @linear/sdk model instances.
 */
export function isOverdue(
  dueDate: string | null,
  stateType: string,
  now: Date = new Date(),
): boolean {
  if (!dueDate) return false;
  if (CLOSED_STATE_TYPES.has(stateType)) return false;
  return new Date(dueDate) < now;
}
