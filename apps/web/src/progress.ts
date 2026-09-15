import type { SpanRecord } from "@agency-os/observability";

export type Source = "linear" | "github" | "slack";
export interface ProgressEvent {
  event:
    | "source.started"
    | "source.completed"
    | "assessment.started"
    | "assessment.completed";
  data: { activityId: number; source?: Source; ok?: boolean };
}
const SOURCES: Record<string, Source> = {
  "tool.linear_list_project_issues": "linear",
  "tool.github_list_pull_requests": "github",
  "tool.github_get_workflow_run_status": "github",
  "tool.slack_get_channel_messages": "slack",
  "tool.slack_get_thread": "slack",
};

/** Reads structural lifecycle fields only. Never spreads records or attributes. */
export class ProgressMapper {
  private readonly seen = new Map<
    string,
    { activityId: number; ended: boolean }
  >();
  poll(spans: readonly SpanRecord[]): ProgressEvent[] {
    const events: { at: string; value: ProgressEvent }[] = [];
    for (const span of spans) {
      const source =
        span.category === "tool" && Object.hasOwn(SOURCES, span.name)
          ? SOURCES[span.name]
          : undefined;
      const assessment =
        (span.category === "model" && span.name === "model.turn") ||
        (span.category === "tool" && span.name === "tool.submit_assessment");
      if (!source && !assessment) continue;
      let state = this.seen.get(span.spanId);
      if (!state) {
        state = { activityId: this.seen.size + 1, ended: false };
        this.seen.set(span.spanId, state);
        events.push({
          at: span.startTime,
          value: {
            event: source ? "source.started" : "assessment.started",
            data: {
              activityId: state.activityId,
              ...(source ? { source } : {}),
            },
          },
        });
      }
      if (span.endTime && !state.ended) {
        state.ended = true;
        events.push({
          at: span.endTime,
          value: {
            event: source ? "source.completed" : "assessment.completed",
            data: {
              activityId: state.activityId,
              ...(source ? { source } : {}),
              ok: span.status === "ok",
            },
          },
        });
      }
    }
    return events
      .sort((a, b) => a.at.localeCompare(b.at))
      .map(({ value }) => value);
  }
}
