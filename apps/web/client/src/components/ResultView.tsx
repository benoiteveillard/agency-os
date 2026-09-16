import type { Activity } from "../hooks/useInvestigation.js";
import type { InvestigationResultDTO } from "../types.js";
import { VerdictBanner } from "./VerdictBanner.js";
import { BlockerList } from "./BlockerList.js";
import { UncertaintyList } from "./UncertaintyList.js";
import { ProposalCard } from "./ProposalCard.js";
import { NarrativeAnswer } from "./NarrativeAnswer.js";
import { MetadataFooter } from "./MetadataFooter.js";
import { SourcesChecked } from "./SourcesChecked.js";

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

  return (
    <div className="result">
      <div className="result-heading">
        <h2>Investigation brief</h2>
        <SourcesChecked activities={activities} />
      </div>

      {result.assessment && <VerdictBanner assessment={result.assessment} />}

      <div className="result-columns">
        <div className="result-primary">
          {result.assessment && result.assessment.blockers.length > 0 && (
            <BlockerList
              blockers={result.assessment.blockers}
              evidenceById={evidenceById}
            />
          )}

          <NarrativeAnswer answer={result.answer} />
        </div>
        {(Boolean(result.assessment?.uncertainty?.length) ||
          result.proposedActionPresentation) && (
          <aside className="result-secondary" aria-label="Follow-up">
            {result.assessment?.uncertainty &&
              result.assessment.uncertainty.length > 0 && (
                <UncertaintyList items={result.assessment.uncertainty} />
              )}

            {result.proposedActionPresentation && (
              <ProposalCard proposal={result.proposedActionPresentation} />
            )}
          </aside>
        )}
      </div>
      <MetadataFooter metadata={result.metadata} />
    </div>
  );
}
