import { newestEvidenceLabel } from "../format.js";
import type { Activity } from "../hooks/useInvestigation.js";
import type { InvestigationResultDTO } from "../types.js";
import { VerdictBanner } from "./VerdictBanner.js";
import { BlockerList } from "./BlockerList.js";
import { UncertaintyList } from "./UncertaintyList.js";
import { ProposalCard } from "./ProposalCard.js";
import { NarrativeAnswer } from "./NarrativeAnswer.js";
import { MetadataFooter } from "./MetadataFooter.js";
import { SOURCE_LABEL, SourcesChecked } from "./SourcesChecked.js";

export function ResultView({
  result,
  activities,
}: {
  result: InvestigationResultDTO;
  activities: Activity[];
}) {
  const evidenceById = new Map(
    result.evidence.map((item) => [item.evidenceId, item]),
  );
  const assessment = result.assessment;
  const blockers = assessment?.blockers ?? [];
  const uncertainty = assessment?.uncertainty ?? [];
  const proposal = result.proposedActionPresentation;
  const citedByBlockers = new Set(
    blockers.flatMap((blocker) => blocker.sources.map((s) => s.evidenceId)),
  );
  const failedSources = activities.flatMap((activity) =>
    activity.kind === "source" &&
    activity.status === "done" &&
    activity.ok === false
      ? [SOURCE_LABEL[activity.source]]
      : [],
  );
  const newestEvidence = newestEvidenceLabel(result.evidence);

  const summary = (
    <dl className="ledger">
      {blockers.length > 0 && (
        <div>
          <dt>Blockers</dt>
          <dd>{blockers.length}</dd>
        </div>
      )}
      {uncertainty.length > 0 && (
        <div>
          <dt>To verify</dt>
          <dd>{uncertainty.length}</dd>
        </div>
      )}
      {newestEvidence && (
        <div>
          <dt>Newest evidence</dt>
          <dd>{newestEvidence}</dd>
        </div>
      )}
      <div>
        <dt>Sources</dt>
        <dd>
          <SourcesChecked activities={activities} />
        </dd>
      </div>
      {proposal && (
        <div>
          <dt>Decision</dt>
          <dd>
            <a href="#decision">1 action proposed</a>
          </dd>
        </div>
      )}
    </dl>
  );

  const hasRail = uncertainty.length > 0 || Boolean(proposal);

  return (
    <div className="result">
      <h1 className="visually-hidden">Investigation brief</h1>
      {assessment ? (
        <VerdictBanner assessment={assessment} failedSources={failedSources}>
          {summary}
        </VerdictBanner>
      ) : (
        <div className="result__summary appear">{summary}</div>
      )}

      <div className={hasRail ? "columns" : undefined}>
        <div className="primary appear appear--1">
          <BlockerList blockers={blockers} evidenceById={evidenceById} />
          <NarrativeAnswer
            answer={result.answer}
            isPrimary={blockers.length === 0}
          />
          <MetadataFooter metadata={result.metadata} />
        </div>
        {hasRail && (
          <aside className="rail appear appear--2" aria-label="Your next steps">
            {proposal && (
              <ProposalCard
                proposal={proposal}
                evidenceById={evidenceById}
                alreadyQuoted={citedByBlockers}
              />
            )}
            <UncertaintyList items={uncertainty} />
          </aside>
        )}
      </div>
    </div>
  );
}
