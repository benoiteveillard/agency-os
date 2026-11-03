import { useCallback, useReducer, useRef } from "react";
import { ApiRequestError, streamInvestigation } from "../api.js";
import type {
  ApiError,
  AssessmentReadyData,
  InvestigationResultDTO,
  SSEMessage,
  Source,
} from "../types.js";

export type ActivityStatus = "in_progress" | "done";
export interface SourceActivity {
  kind: "source";
  source: Source;
  status: ActivityStatus;
  ok?: boolean;
}
export interface AssessingActivity {
  kind: "assessing";
  status: ActivityStatus;
}
export type Activity = SourceActivity | AssessingActivity;

/** What assessment.ready reports, before the full result arrives. */
export type PreliminaryVerdict = AssessmentReadyData;

export type InvestigationState =
  | { phase: "idle" }
  | {
      phase: "running";
      question: string;
      traceId?: string;
      activities: Activity[];
      preliminary?: PreliminaryVerdict;
      /** Internal: distinguishes this run from a superseded one whose
       * in-flight SSE messages may still be arriving after abort() is
       * called but before the stream actually stops. */
      runId: number;
    }
  | {
      phase: "completed";
      question: string;
      activities: Activity[];
      result: InvestigationResultDTO;
    }
  | {
      phase: "failed";
      question: string;
      activities: Activity[];
      error: ApiError;
      traceId?: string;
    };

type Action =
  | { type: "start"; question: string; runId: number }
  | { type: "message"; message: SSEMessage; runId: number }
  | { type: "transportError"; error: ApiError; runId: number }
  | { type: "streamEnded"; runId: number }
  | { type: "reset" };

function upsertSource(
  activities: Activity[],
  source: Source,
  status: ActivityStatus,
  ok?: boolean,
): Activity[] {
  const index = activities.findIndex(
    (a): a is SourceActivity => a.kind === "source" && a.source === source,
  );
  const next: SourceActivity = { kind: "source", source, status, ok };
  if (index === -1) return [...activities, next];
  const copy = activities.slice();
  copy[index] = next;
  return copy;
}

function upsertAssessing(
  activities: Activity[],
  status: ActivityStatus,
): Activity[] {
  const index = activities.findIndex((a) => a.kind === "assessing");
  const next: AssessingActivity = { kind: "assessing", status };
  if (index === -1) return [...activities, next];
  if (activities[index]?.status === "done") return activities; // never regress a settled step
  const copy = activities.slice();
  copy[index] = next;
  return copy;
}

/** Only settles an assessing row that genuinely started — never fabricates
 * one for a question that never triggered any real assessment activity. */
function finalizeAssessing(activities: Activity[]): Activity[] {
  const index = activities.findIndex((a) => a.kind === "assessing");
  if (index === -1 || activities[index]?.status === "done") return activities;
  const copy = activities.slice();
  copy[index] = { kind: "assessing", status: "done" };
  return copy;
}

function reducer(
  state: InvestigationState,
  action: Action,
): InvestigationState {
  if (action.type === "reset" || action.type === "start") {
    return action.type === "start"
      ? {
          phase: "running",
          question: action.question,
          activities: [],
          runId: action.runId,
        }
      : { phase: "idle" };
  }
  if (state.phase !== "running" || action.runId !== state.runId) return state;
  if (action.type === "transportError") {
    return {
      phase: "failed",
      question: state.question,
      activities: state.activities,
      error: action.error,
      traceId: state.traceId,
    };
  }
  if (action.type === "streamEnded") {
    // Still running here means the stream closed without a completed or failed
    // event (a proxy cut, a server restart). A terminal event would already
    // have moved this run out of "running".
    return {
      phase: "failed",
      question: state.question,
      activities: state.activities,
      error: {
        code: "network_error",
        message: "Connection to the server was interrupted.",
      },
      traceId: state.traceId,
    };
  }
  const { message } = action;
  switch (message.event) {
    case "investigation.started":
      return { ...state, traceId: message.data.traceId };
    case "source.started":
      return {
        ...state,
        activities: upsertSource(
          state.activities,
          message.data.source,
          "in_progress",
        ),
      };
    case "source.completed":
      return {
        ...state,
        activities: upsertSource(
          state.activities,
          message.data.source,
          "done",
          message.data.ok,
        ),
      };
    case "assessment.started":
      return {
        ...state,
        activities: upsertAssessing(state.activities, "in_progress"),
      };
    case "assessment.ready":
      return {
        ...state,
        activities: upsertAssessing(state.activities, "done"),
        preliminary: message.data,
      };
    case "action.proposed":
    case "assessment.completed":
      return state;
    case "investigation.completed":
      return {
        phase: "completed",
        question: state.question,
        activities: finalizeAssessing(state.activities),
        result: message.data,
      };
    case "investigation.failed":
      return {
        phase: "failed",
        question: state.question,
        activities: state.activities,
        error: message.data.error,
        traceId: message.data.traceId ?? state.traceId,
      };
    default:
      return state;
  }
}

export function useInvestigation() {
  const [state, dispatch] = useReducer(reducer, { phase: "idle" });
  const controllerRef = useRef<AbortController | undefined>(undefined);
  const runIdRef = useRef(0);

  const run = useCallback(async (question: string) => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const runId = ++runIdRef.current;
    dispatch({ type: "start", question, runId });
    try {
      for await (const message of streamInvestigation(
        question,
        controller.signal,
      )) {
        dispatch({ type: "message", message, runId });
      }
      dispatch({ type: "streamEnded", runId });
    } catch (error) {
      if (controller.signal.aborted) return;
      dispatch({
        type: "transportError",
        runId,
        error:
          error instanceof ApiRequestError
            ? { code: error.code, message: error.message }
            : {
                code: "network_error",
                message: "Connection to the server was interrupted.",
              },
      });
    }
  }, []);

  const reset = useCallback(() => {
    controllerRef.current?.abort();
    dispatch({ type: "reset" });
  }, []);

  return { state, run, reset };
}
