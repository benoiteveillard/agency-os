import { useCallback, useReducer } from "react";
import { decideProposal, type Decision } from "../api.js";
import type { ApiError, AuditDTO } from "../types.js";

export type ProposalState =
  | { phase: "pending" }
  | { phase: "deciding"; decision: Decision }
  | { phase: "decided"; audit: AuditDTO }
  | { phase: "error"; error: ApiError; decision: Decision };

type Action =
  | { type: "start"; decision: Decision }
  | { type: "succeeded"; audit: AuditDTO }
  | { type: "failed"; error: ApiError; decision: Decision };

function reducer(_state: ProposalState, action: Action): ProposalState {
  switch (action.type) {
    case "start":
      return { phase: "deciding", decision: action.decision };
    case "succeeded":
      return { phase: "decided", audit: action.audit };
    case "failed":
      return { phase: "error", error: action.error, decision: action.decision };
  }
}

export function useProposalDecision(proposalId: string) {
  const [state, dispatch] = useReducer(reducer, { phase: "pending" });

  const decide = useCallback(
    async (decision: Decision) => {
      dispatch({ type: "start", decision });
      const outcome = await decideProposal(proposalId, decision);
      if (outcome.ok) dispatch({ type: "succeeded", audit: outcome.audit });
      else dispatch({ type: "failed", error: outcome.error, decision });
    },
    [proposalId],
  );

  return { state, decide };
}
