import type { AssessmentBlocker, Evidence } from "../types.js";

const ROLE_LABEL: Record<string, string> = {
  authoritative: "Authoritative",
  corroborating: "Corroborating",
  historical: "Historical",
};

function EvidenceChip({
  evidenceId,
  role,
  evidence,
}: {
  evidenceId: string;
  role: string;
  evidence?: Evidence;
}) {
  const source = evidence?.source ?? evidenceId.split(":")[0];
  const id = evidence?.id ?? evidenceId.split(":").slice(1).join(":");
  const content = (
    <>
      <span className="evidence-chip__source">{source}</span>
      <span className="evidence-chip__id">{id}</span>
      <span className={`role-tag role-tag--${role}`}>
        {ROLE_LABEL[role] ?? role}
      </span>
    </>
  );
  if (evidence?.url) {
    return (
      <a
        className="evidence-chip"
        href={evidence.url}
        target="_blank"
        rel="noreferrer noopener"
      >
        {content}
      </a>
    );
  }
  return <span className="evidence-chip">{content}</span>;
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
        Launch blockers
      </h3>
      <ol className="blocker-list">
        {blockers.map((blocker, index) => (
          <li className="blocker" key={`${blocker.title}-${index}`}>
            <span className="blocker__index" aria-hidden="true">
              {String(index + 1).padStart(2, "0")}
            </span>
            <div>
              <h4 className="blocker__title">{blocker.title}</h4>
              <p className="blocker__explanation">{blocker.explanation}</p>
              <ul className="evidence-chips" aria-label="Supporting evidence">
                {blocker.sources.map((ref, refIndex) => (
                  <li key={`${ref.evidenceId}-${refIndex}`}>
                    <EvidenceChip
                      evidenceId={ref.evidenceId}
                      role={ref.role}
                      evidence={evidenceById.get(ref.evidenceId)}
                    />
                  </li>
                ))}
              </ul>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
