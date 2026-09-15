import { useState } from "react";

/** Plain text, preserved whitespace — no Markdown rendering, so no
 * sanitization dependency is needed for model-authored text. */
export function NarrativeAnswer({ answer }: { answer: string }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="narrative">
      <button
        type="button"
        className="narrative__toggle"
        aria-expanded={open}
        aria-controls="narrative-body"
        onClick={() => setOpen((v) => !v)}
      >
        Detailed analysis
        <span aria-hidden="true">{open ? "−" : "+"}</span>
      </button>
      {open && (
        <div className="narrative__body" id="narrative-body">
          {answer}
        </div>
      )}
    </section>
  );
}
