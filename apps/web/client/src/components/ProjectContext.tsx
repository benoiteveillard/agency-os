import { useState, type FormEvent } from "react";

export const SUGGESTED_QUESTION =
  "Are we still on track to launch Project Acme on Friday?";

const INTEGRATIONS = ["Linear", "GitHub", "Slack"] as const;

export function ProjectContext({
  onAsk,
  disabled,
  compact = false,
}: {
  onAsk: (question: string) => void;
  disabled: boolean;
  compact?: boolean;
}) {
  const [question, setQuestion] = useState("");

  function submit(e: FormEvent) {
    e.preventDefault();
    const trimmed = question.trim();
    if (trimmed) onAsk(trimmed);
  }

  return (
    <section className="project-context" aria-labelledby="project-title">
      <div className="project-eyebrow">
        Workspace <span aria-hidden="true">/</span> Project overview
      </div>
      <h1 id="project-title" className="project-context__title">
        Acme Website Migration
      </h1>
      <p className="project-context__meta">
        Target launch · Friday, September 18 · digital agency client project
      </p>

      <div className="integration-badges" aria-label="Project data sources">
        {INTEGRATIONS.map((name) => (
          <span className="integration-badge" key={name}>
            <span
              className={`integration-symbol integration-symbol--${name.toLowerCase()}`}
              aria-hidden="true"
            >
              {name === "Linear" ? "◩" : name === "GitHub" ? "⌘" : "#"}
            </span>
            {name}
          </span>
        ))}
      </div>

      <div className="ask-panel">
        <p className="ask-panel__intro">
          A clearer picture. A better next step.
        </p>
        <label className="ask-panel__label" htmlFor="investigation-question">
          Ask about this project
        </label>
        <form className="ask-form" onSubmit={submit}>
          <textarea
            id="investigation-question"
            className="ask-input"
            rows={compact ? 1 : 2}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="What needs your attention before launch?"
            disabled={disabled}
            maxLength={8000}
          />
          <button
            type="submit"
            className="btn btn-primary"
            aria-label={disabled ? "Investigating" : "Ask"}
            disabled={disabled || !question.trim()}
          >
            {disabled ? "Investigating…" : "Ask"}
            <span aria-hidden="true"> ↗</span>
          </button>
        </form>
        <div className="suggested-question">
          <span className="progress-item__hint">Start here</span>
          <button
            type="button"
            className="suggested-question__chip"
            disabled={disabled}
            onClick={() => {
              setQuestion(SUGGESTED_QUESTION);
              onAsk(SUGGESTED_QUESTION);
            }}
          >
            {SUGGESTED_QUESTION}
          </button>
        </div>
      </div>
    </section>
  );
}
