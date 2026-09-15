import type { Activity } from "../hooks/useInvestigation.js";

const SOURCE_LABEL: Record<string, { label: string; hint: string }> = {
  linear: { label: "Linear", hint: "Project issues checked" },
  github: { label: "GitHub", hint: "Pull requests & CI checked" },
  slack: { label: "Slack", hint: "Gathering project context" },
};

function icon(status: Activity["status"], ok?: boolean) {
  if (status === "done") return ok === false ? "!" : "✓";
  return "";
}

function statusClass(status: Activity["status"], ok?: boolean) {
  if (status === "done" && ok === false) return "failed";
  return status;
}

export function InvestigationProgress({
  activities,
}: {
  activities: Activity[];
}) {
  if (activities.length === 0) return null;
  return (
    <section
      className="progress"
      aria-live="polite"
      aria-label="Investigation progress"
    >
      <p className="progress__title">Investigating launch readiness</p>
      <ul className="progress-list">
        {activities.map((activity, index) => {
          const cls = statusClass(
            activity.status,
            activity.kind === "source" ? activity.ok : undefined,
          );
          const label =
            activity.kind === "source"
              ? SOURCE_LABEL[activity.source]?.label
              : "Assessing launch readiness";
          const hint =
            activity.kind === "source"
              ? SOURCE_LABEL[activity.source]?.hint
              : undefined;
          return (
            <li
              key={activity.kind === "source" ? activity.source : "assessing"}
              className={`progress-item progress-item--${cls}`}
            >
              <span className="progress-item__icon" aria-hidden="true">
                {icon(
                  activity.status,
                  activity.kind === "source" ? activity.ok : undefined,
                )}
              </span>
              <span>
                <span className="progress-item__label">{label}</span>
                {hint ? (
                  <>
                    {" "}
                    <span className="progress-item__hint">— {hint}</span>
                  </>
                ) : null}
              </span>
              <span className="visually-hidden">
                {activity.status === "done" ? "done" : "in progress"}, position{" "}
                {index + 1} of {activities.length}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
