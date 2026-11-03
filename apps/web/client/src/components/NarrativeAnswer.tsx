import { Icon } from "./Icon.js";

/**
 * Plain text, preserved whitespace: no Markdown rendering, so no sanitization
 * dependency is needed for model-authored text. Collapsed only when blockers
 * already carry the conclusion; otherwise this text is the result, and hiding
 * it would leave an empty page.
 */
export function NarrativeAnswer({
  answer,
  isPrimary,
}: {
  answer: string;
  isPrimary: boolean;
}) {
  if (!answer) return null;
  if (isPrimary) return <div className="answer">{answer}</div>;
  return (
    <details className="disclosure-panel">
      <summary>
        Full analysis
        <Icon name="CaretDown" />
      </summary>
      <div className="disclosure-panel__body answer--secondary">{answer}</div>
    </details>
  );
}
