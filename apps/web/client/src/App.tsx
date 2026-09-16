import { Header } from "./components/Header.js";
import { Disclosure } from "./components/Disclosure.js";
import { ProjectContext } from "./components/ProjectContext.js";
import { InvestigationProgress } from "./components/InvestigationProgress.js";
import { ResultView } from "./components/ResultView.js";
import { ErrorState } from "./components/ErrorState.js";
import { HowItWorks } from "./components/HowItWorks.js";
import { useInvestigation } from "./hooks/useInvestigation.js";

export function App() {
  const { state, run } = useInvestigation();
  const running = state.phase === "running";

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <Header />
      <div className="app-body">
        <main id="main-content" className={`app-main app-main--${state.phase}`}>
          <ProjectContext
            onAsk={(question) => run(question)}
            disabled={running}
            compact={state.phase !== "idle"}
          />

          <p className="visually-hidden" role="status">
            {state.phase === "completed"
              ? "Investigation complete. Your brief is ready below."
              : ""}
          </p>
          {(state.phase === "running" ||
            (state.phase === "failed" && state.activities.length > 0)) && (
            <InvestigationProgress activities={state.activities} />
          )}

          {state.phase === "completed" && (
            <ResultView
              key={state.result.metadata.traceId}
              result={state.result}
              activities={state.activities}
            />
          )}

          {state.phase === "failed" && (
            <ErrorState
              error={state.error}
              onRetry={() => run(state.question)}
            />
          )}

          {state.phase === "idle" && <HowItWorks />}
          <Disclosure />
        </main>
      </div>
    </div>
  );
}
