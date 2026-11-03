import type { Activity } from "../hooks/useInvestigation.js";
import type { Source } from "../types.js";
import { Icon } from "./Icon.js";

export const SOURCE_LABEL: Record<Source, string> = {
  linear: "Linear",
  github: "GitHub",
  slack: "Slack",
};

const ALL_SOURCES: Source[] = ["linear", "github", "slack"];

/** Lists every source, so one the agent didn't consult is visible rather than absent. */
export function SourcesChecked({ activities }: { activities: Activity[] }) {
  return (
    <span className="sources" role="group" aria-label="Sources checked">
      {ALL_SOURCES.map((source) => {
        const activity = activities.find(
          (a): a is Extract<Activity, { kind: "source" }> =>
            a.kind === "source" && a.source === source,
        );
        const failed = activity?.ok === false;
        const checked = activity?.status === "done" && !failed;
        const modifier = failed
          ? " sources__item--failed"
          : checked
            ? ""
            : " sources__item--unknown";
        return (
          <span className={`sources__item${modifier}`} key={source}>
            <Icon
              name={failed ? "Cross" : checked ? "Check" : "Question"}
              small
            />
            {SOURCE_LABEL[source]}
            {checked ? (
              <span className="visually-hidden"> checked</span>
            ) : failed ? (
              " failed"
            ) : activity ? (
              " incomplete"
            ) : (
              " not checked"
            )}
          </span>
        );
      })}
    </span>
  );
}
