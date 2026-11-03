import { useState, type FormEvent, type KeyboardEvent } from "react";
import { Disclosure } from "./Disclosure.js";
import { Icon } from "./Icon.js";

const STARTERS = [
  "Are we still on track to launch Project Acme on Friday?",
  "What is blocking Project Acme?",
  "Has the client formally approved the checkout?",
];
const HINT = "Enter to ask. Shift and Enter for a new line.";

export function AskView({ onAsk }: { onAsk: (question: string) => void }) {
  const [question, setQuestion] = useState("");
  const [invalid, setInvalid] = useState(false);

  function submit(e: FormEvent | KeyboardEvent) {
    e.preventDefault();
    const trimmed = question.trim();
    if (trimmed) onAsk(trimmed);
    else setInvalid(true);
  }

  return (
    <section className="ask appear" aria-labelledby="ask-title">
      <div>
        <h1 id="ask-title" className="ask__title">
          What do you need to know about this launch?
        </h1>
        <p className="ask__lead">
          I read this project&rsquo;s Linear, GitHub and Slack, then give you a
          verdict with its sources.
        </p>
      </div>

      <form className="composer" onSubmit={submit} noValidate>
        <label className="visually-hidden" htmlFor="investigation-question">
          Ask about this project
        </label>
        <textarea
          id="investigation-question"
          className="composer__input"
          rows={2}
          maxLength={8000}
          value={question}
          placeholder="Ask about delivery risk, blockers or approvals"
          aria-describedby="composer-message"
          aria-invalid={invalid}
          onChange={(e) => {
            setQuestion(e.target.value);
            setInvalid(false);
          }}
          onKeyDown={(e) => {
            // Enter asks, Shift+Enter adds a line. isComposing leaves an IME's
            // own Enter alone.
            if (
              e.key === "Enter" &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing
            ) {
              submit(e);
            }
          }}
        />
        <div className="composer__foot">
          <p
            id="composer-message"
            className={invalid ? "composer__message--error" : undefined}
          >
            {invalid ? "Type a question first." : HINT}
          </p>
          <button type="submit" className="btn btn-primary">
            Investigate <Icon name="ArrowRight" />
          </button>
        </div>
      </form>

      <div className="starters">
        <h2 className="starters__title">Start with one of these</h2>
        {STARTERS.map((starter) => (
          <button
            type="button"
            className="starter"
            key={starter}
            onClick={() => onAsk(starter)}
          >
            <span>{starter}</span>
            <Icon name="ArrowRight" />
          </button>
        ))}
      </div>

      <div className="boundaries">
        <div>
          <h3>Reads on its own</h3>
          <p>It chooses which sources to check for your question.</p>
        </div>
        <div>
          <h3>Shows its evidence</h3>
          <p>Each blocker points to the records behind it.</p>
        </div>
        <div>
          <h3>Writes only with you</h3>
          <p>It can propose one Linear issue. You approve or reject it.</p>
        </div>
      </div>
      <Disclosure />
    </section>
  );
}
