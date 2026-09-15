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
      <SourcesChecked activities={activities} />

      {result.assessment && <VerdictBanner assessment={result.assessment} />}

      {result.assessment && result.assessment.blockers.length > 0 && (
        <BlockerList
          blockers={result.assessment.blockers}
          evidenceById={evidenceById}
        />
      )}

      {result.assessment?.uncertainty &&
        result.assessment.uncertainty.length > 0 && (
          <UncertaintyList items={result.assessment.uncertainty} />
        )}

      {result.proposedActionPresentation && (
        <ProposalCard proposal={result.proposedActionPresentation} />
      )}

      <NarrativeAnswer answer={result.answer} />

      <MetadataFooter metadata={result.metadata} />
    </div>
  );
}
