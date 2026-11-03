import { formatDate } from "../format.js";
import type { AssessmentBlocker, Evidence, Source } from "../types.js";
import { Icon, type IconName } from "./Icon.js";

const ROLE_LABEL: Record<string, string> = {
  authoritative: "Decides status",
  corroborating: "Supports",
  historical: "Older context",
};

const SOURCE: Record<string, { name: string; icon: IconName }> = {
  linear: { name: "Linear", icon: "Linear" },
  github: { name: "GitHub", icon: "Github" },
  slack: { name: "Slack", icon: "Slack" },
};

function describe(evidenceId: string, evidence?: Evidence) {
  const source: Source | string =
    evidence?.source ?? evidenceId.split(":")[0] ?? "";
  // A Slack ts is an internal key, meaningless to a reader. The date beside it
  // is what identifies the message.
  const id =
    source === "slack"
      ? "message"
      : (evidence?.id ?? evidenceId.split(":").slice(1).join(":"));
  return { source: SOURCE[source], sourceKey: source, id };
}

function EvidenceId({ id, url }: { id: string; url?: string }) {
  if (!url) return <span className="evidence__id">{id}</span>;
  return (
    <a
      className="evidence__id evidence__id--link"
      href={url}
      target="_blank"
      rel="noreferrer noopener"
    >
      {id}
      <Icon name="ArrowUpRight" small />
    </a>
  );
}

/** A cited source: the link, plus when it dates from and what it says. */
export function EvidenceCitation({
  evidenceId,
  role,
  evidence,
  quote = true,
}: {
  evidenceId: string;
  role?: string;
  evidence?: Evidence;
  /** Off where the same excerpt is already on screen, so it isn't printed twice. */
  quote?: boolean;
}) {
  const { source, sourceKey, id } = describe(evidenceId, evidence);
  const date = formatDate(evidence?.timestamp);
  return (
    <div className="evidence">
      <div className="evidence__head">
        {source && <Icon name={source.icon} small />}
        <span>{source?.name ?? sourceKey}</span>
        <EvidenceId id={id} url={evidence?.url} />
        {date && (
          <time className="evidence__date" dateTime={evidence?.timestamp}>
            {date}
          </time>
        )}
        {role && (
          <span className={`role role--${role}`}>
            {ROLE_LABEL[role] ?? role}
          </span>
        )}
      </div>
      {quote && evidence?.excerpt && (
        <p className="evidence-excerpt">{evidence.excerpt}</p>
      )}
    </div>
  );
}

export function BlockerList({
  blockers,
  evidenceById,
}: {
  blockers: AssessmentBlocker[];
  evidenceById: Map<string, Evidence>;
}) {
  if (blockers.length === 0) return null;
  return (
    <section aria-labelledby="blockers-heading">
      <h3 id="blockers-heading" className="section-heading">
        What is blocking the launch
      </h3>
      <ol className="blockers">
        {blockers.map((blocker, index) => (
          <li key={`${blocker.title}-${index}`}>
            <details className="blocker" open={index === 0}>
              <summary>
                <span>
                  <span className="blocker__title">{blocker.title}</span>
                  <span className="blocker__explanation">
                    {blocker.explanation}
                  </span>
                </span>
                <Icon name="CaretDown" />
              </summary>
              <ul
                className="blocker__evidence"
                aria-label="Supporting evidence"
              >
                {blocker.sources.map((ref, refIndex) => (
                  <li key={`${ref.evidenceId}-${refIndex}`}>
                    <EvidenceCitation
                      evidenceId={ref.evidenceId}
                      role={ref.role}
                      evidence={evidenceById.get(ref.evidenceId)}
                    />
                  </li>
                ))}
              </ul>
            </details>
          </li>
        ))}
      </ol>
    </section>
  );
}
