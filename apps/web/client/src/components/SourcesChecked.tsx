import type { Activity } from "../hooks/useInvestigation.js";

const LABEL: Record<string, string> = {
  linear: "Linear",
  github: "GitHub",
  slack: "Slack",
};

export function SourcesChecked({ activities }: { activities: Activity[] }) {
  const sources = activities.filter(
    (a): a is Extract<Activity, { kind: "source" }> => a.kind === "source",
  );
  if (sources.length === 0) return null;
  return (
    <section aria-label="Sources checked">
      <h3 className="section-heading">Sources checked</h3>
      <div className="sources-checked">
        {sources.map((activity) => {
          const checked = activity.status === "done" && activity.ok !== false;
          return (
            <span
              className={`sources-checked__item${checked ? " sources-checked__item--checked" : ""}`}
              key={activity.source}
            >
              {LABEL[activity.source]}{" "}
              {checked
                ? "✓"
                : activity.ok === false
                  ? "— check failed"
                  : "— incomplete"}
            </span>
          );
        })}
      </div>
    </section>
  );
}
