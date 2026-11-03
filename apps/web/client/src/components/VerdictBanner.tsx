import type { Assessment, AssessmentVerdict } from "../types.js";
import { Icon } from "./Icon.js";

export const VERDICT_LABEL: Record<AssessmentVerdict, string> = {
  on_track: "On track",
  at_risk: "At risk",
  high_risk: "High risk",
  insufficient_evidence: "Insufficient evidence",
};

export function VerdictIcon({ verdict }: { verdict: AssessmentVerdict }) {
  if (verdict === "on_track") return <Icon name="Check" />;
  if (verdict === "insufficient_evidence") return <Icon name="Question" />;
  return <Icon name="Warning" />;
}

function joinNames(names: string[]): string {
  return names.length > 1
    ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`
    : (names[0] ?? "");
}

export function VerdictBanner({
  assessment,
  failedSources,
  children,
}: {
  assessment: Assessment;
  failedSources: string[];
  /** The run summary: blockers, sources, evidence age. */
  children: React.ReactNode;
}) {
  return (
    <section
      className={`verdict tone-${assessment.verdict} appear`}
      aria-label="Assessment verdict"
    >
      <span className="verdict-label">
        <VerdictIcon verdict={assessment.verdict} />
        {VERDICT_LABEL[assessment.verdict]}
      </span>
      <h2 className="verdict__headline">{assessment.summary}</h2>
      {failedSources.length > 0 && (
        <p className="verdict__caveat">
          <Icon name="Warning" />
          <span>
            {joinNames(failedSources)} couldn&rsquo;t be checked, so this
            verdict doesn&rsquo;t account for{" "}
            {failedSources.length > 1 ? "them" : "it"}.
          </span>
        </p>
      )}
      {children}
    </section>
  );
}
