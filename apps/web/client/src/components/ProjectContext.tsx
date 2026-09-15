import { useState, type FormEvent } from "react";

export const SUGGESTED_QUESTION =
  "Are we still on track to launch Project Acme on Friday?";

const INTEGRATIONS = ["Linear", "GitHub", "Slack"] as const;

export function ProjectContext({
  onAsk,
  disabled,
}: {
  onAsk: (question: string) => void;
  disabled: boolean;
}) {
  const [question, setQuestion] = useState("");

  function submit(e: FormEvent) {
    e.preventDefault();
    const trimmed = question.trim();
    if (trimmed) onAsk(trimmed);
  }

  return (
    <section className="project-context" aria-labelledby="project-title">
      <h1 id="project-title" className="project-context__title">
        Acme Website Migration
      </h1>
      <p className="project-context__meta">
        Target launch · Friday, September 18 · digital agency client project
      </p>

      <div className="integration-badges" aria-label="Connected integrations">
        {INTEGRATIONS.map((name) => (
          <span className="integration-badge" key={name}>
            <span aria-hidden="true">●</span>
            {name}
          </span>
        ))}
      </div>

      <div className="ask-panel">
        <label className="ask-panel__label" htmlFor="investigation-question">
          Ask about this project
        </label>
        <form className="ask-form" onSubmit={submit}>
          <input
            id="investigation-question"
            className="ask-input"
            type="text"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder={SUGGESTED_QUESTION}
            disabled={disabled}
            maxLength={8000}
          />
          <button
            type="submit"
            className="btn btn-primary"
            disabled={disabled || !question.trim()}
          >
            Ask
          </button>
        </form>
        <div className="suggested-question">
          <span className="progress-item__hint">Try:</span>
          <button
            type="button"
            className="suggested-question__chip"
            disabled={disabled}
            onClick={() => onAsk(SUGGESTED_QUESTION)}
          >
            {SUGGESTED_QUESTION}
          </button>
        </div>
      </div>
    </section>
  );
}
