import { useEffect } from "react";
import { Header } from "./components/Header.js";
import { AskView } from "./components/AskView.js";
import { InvestigationProgress } from "./components/InvestigationProgress.js";
import { ResultView } from "./components/ResultView.js";
import { ErrorState } from "./components/ErrorState.js";
import { useInvestigation } from "./hooks/useInvestigation.js";

export function App() {
  const { state, run, reset } = useInvestigation();

  // Each phase is a new view: don't leave the reader partway down the last one.
  useEffect(() => {
    document.documentElement.scrollTop = 0;
  }, [state.phase]);

  return (
    <>
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <Header />
      <main id="main-content" className="page">
        <p className="visually-hidden" role="status">
          {state.phase === "completed"
            ? "Investigation complete. Your brief is ready below."
            : ""}
        </p>

        {state.phase === "idle" && <AskView onAsk={(q) => run(q)} />}

        {state.phase !== "idle" && (
          <div className="question-line">
            <p>{state.question}</p>
            {state.phase !== "running" && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={reset}
              >
                New question
              </button>
            )}
          </div>
        )}

        {state.phase === "running" && (
          <div className="run-grid appear">
            <div className="skeleton" aria-hidden="true">
              <i className="skeleton__block" />
              <i />
              <i className="skeleton__short" />
              <i className="skeleton__block" />
              <i className="skeleton__block" />
            </div>
            <InvestigationProgress
              activities={state.activities}
              preliminary={state.preliminary}
              draft={state.draft}
              onCancel={reset}
            />
          </div>
        )}

        {state.phase === "completed" && (
          <ResultView
            key={state.result.metadata.traceId}
            result={state.result}
            activities={state.activities}
          />
        )}

        {state.phase === "failed" && (
          <div className="failed appear">
            <ErrorState
              error={state.error}
              onRetry={() => run(state.question)}
            />
            {state.activities.length > 0 && (
              <InvestigationProgress activities={state.activities} stopped />
            )}
          </div>
        )}
      </main>
    </>
  );
}
