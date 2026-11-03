import { useEffect, useState } from "react";
import type {
  Activity,
  PreliminaryVerdict,
} from "../hooks/useInvestigation.js";
import { Icon } from "./Icon.js";
import { VERDICT_LABEL, VerdictIcon } from "./VerdictBanner.js";

const SOURCE_LABEL: Record<string, { label: string; hint: string }> = {
  linear: { label: "Linear", hint: "project issues" },
  github: { label: "GitHub", hint: "pull requests and CI" },
  slack: { label: "Slack", hint: "project conversations" },
};

/** Real elapsed time, because a run takes a minute or more and nothing else moves for long stretches. */
function ElapsedSeconds() {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  return <span aria-hidden="true"> · {seconds} s</span>;
}

function assessingHint(status: Activity["status"], interrupted: boolean) {
  if (interrupted) return "Didn’t finish";
  return status === "done"
    ? "Compared what each source says"
    : "Comparing what each source says";
}

function sourceHint(
  activity: Extract<Activity, { kind: "source" }>,
  interrupted: boolean,
) {
  const hint = SOURCE_LABEL[activity.source]?.hint;
  if (interrupted) return `Didn’t finish checking ${hint}`;
  if (activity.status === "in_progress") return `Checking ${hint}`;
  return activity.ok === false ? `Could not check ${hint}` : `Checked ${hint}`;
}

export function InvestigationProgress({
  activities,
  preliminary,
  stopped = false,
  onCancel,
}: {
  activities: Activity[];
  /** The verdict, once known, while the rest of the brief is still being written. */
  preliminary?: PreliminaryVerdict;
  /** The run has ended without a result: nothing here is still in progress. */
  stopped?: boolean;
  onCancel?: () => void;
}) {
  const ordered = [
    ...activities.filter((a) => a.kind === "source"),
    ...activities.filter((a) => a.kind !== "source"),
  ];
  return (
    <section
      className="activity"
      aria-live="polite"
      aria-label="Investigation progress"
    >
      <div className="activity__head">
        <div>
          <h2>{stopped ? "Investigation stopped" : "Investigating"}</h2>
          {!stopped && (
            <p>
              Usually takes a minute or two
              <ElapsedSeconds />
            </p>
          )}
        </div>
        {!stopped && onCancel && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={onCancel}
          >
            Cancel
          </button>
        )}
      </div>
      {ordered.length > 0 && (
        <ul className="progress-list">
          {ordered.map((activity, index) => {
            const interrupted = stopped && activity.status === "in_progress";
            const failed = activity.kind === "source" && activity.ok === false;
            const cls = interrupted
              ? "interrupted"
              : failed
                ? "failed"
                : activity.status;
            return (
              <li
                key={activity.kind === "source" ? activity.source : "assessing"}
                className={`progress-item progress-item--${cls}`}
              >
                <span className="progress-item__mark" aria-hidden="true">
                  {activity.status === "done" ? (
                    <Icon name={failed ? "Cross" : "Check"} />
                  ) : (
                    <span className="progress-item__dot" />
                  )}
                </span>
                <span>
                  <span className="progress-item__label">
                    {activity.kind === "source"
                      ? SOURCE_LABEL[activity.source]?.label
                      : "Weighing the evidence"}
                  </span>
                  <span className="progress-item__hint">
                    {activity.kind === "source"
                      ? sourceHint(activity, interrupted)
                      : assessingHint(activity.status, interrupted)}
                  </span>
                </span>
                <span className="visually-hidden">
                  {failed
                    ? "failed"
                    : interrupted
                      ? "did not finish"
                      : activity.status === "done"
                        ? "done"
                        : "in progress"}
                  , position {index + 1} of {activities.length}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {preliminary && !stopped && (
        <p className={`activity__early tone-${preliminary.verdict}`}>
          <span className="verdict-label">
            <VerdictIcon verdict={preliminary.verdict} />
            {VERDICT_LABEL[preliminary.verdict]}
          </span>
          <span>
            {preliminary.blockerCount === 0
              ? "No blockers found."
              : `${preliminary.blockerCount} blocker${preliminary.blockerCount === 1 ? "" : "s"} found.`}{" "}
            Writing the brief.
          </span>
        </p>
      )}
    </section>
  );
}
