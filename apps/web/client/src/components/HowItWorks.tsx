const STEPS = [
  {
    title: "Ask",
    body: "A plain-language question about project delivery risk.",
  },
  {
    title: "Investigate",
    body: "Real evidence pulled from Linear, GitHub and Slack.",
  },
  {
    title: "Assess",
    body: "An evidence-backed launch-risk verdict, with sources.",
  },
  {
    title: "Act",
    body: "A recommended mitigation, only ever executed with your approval.",
  },
];

export function HowItWorks() {
  return (
    <section className="how-it-works" aria-labelledby="how-it-works-heading">
      <h2 id="how-it-works-heading" className="section-heading">
        How it works
      </h2>
      <div className="how-it-works__steps">
        {STEPS.map((step) => (
          <div className="how-it-works__step" key={step.title}>
            <p className="how-it-works__step-title">{step.title}</p>
            <p className="how-it-works__step-body">{step.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
