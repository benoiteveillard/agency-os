import type { Assessment } from "../types.js";

const VERDICT_COPY: Record<
  Assessment["verdict"],
  { label: string; headline: string }
> = {
  on_track: {
    label: "On track",
    headline: "No unresolved issue currently threatens this launch.",
  },
  at_risk: {
    label: "At risk",
    headline: "Unresolved issues could threaten this launch.",
  },
  high_risk: {
    label: "High risk",
    headline: "This launch is materially threatened.",
  },
  insufficient_evidence: {
    label: "Insufficient evidence",
    headline: "There isn't enough evidence to judge launch readiness.",
  },
};

export function VerdictBanner({ assessment }: { assessment: Assessment }) {
  const copy = VERDICT_COPY[assessment.verdict];
  const blockerCount = assessment.blockers.length;
  const uncertaintyCount = assessment.uncertainty?.length ?? 0;
  return (
    <section
      className={`verdict-banner verdict-banner--${assessment.verdict}`}
      aria-label="Assessment verdict"
    >
      <span className="verdict-banner__label">{copy.label}</span>
      <h2 className="verdict-banner__headline">{copy.headline}</h2>
      <p className="verdict-banner__summary">{assessment.summary}</p>
      {(blockerCount > 0 || uncertaintyCount > 0) && (
        <p className="verdict-banner__counts">
          {blockerCount} blocker{blockerCount === 1 ? "" : "s"}
          {uncertaintyCount > 0
            ? ` · ${uncertaintyCount} uncertaint${uncertaintyCount === 1 ? "y" : "ies"}`
            : ""}
        </p>
      )}
    </section>
  );
}
