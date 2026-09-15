import { Header } from "./components/Header.js";
import { Sidebar } from "./components/Sidebar.js";
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
      <Header />
      <div className="app-body">
        <Sidebar />
        <main className="app-main">
          <Disclosure />
          <ProjectContext
            onAsk={(question) => run(question)}
            disabled={running}
          />

          {(state.phase === "running" || state.phase === "failed") && (
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

          <HowItWorks />
        </main>
      </div>
    </div>
  );
}
