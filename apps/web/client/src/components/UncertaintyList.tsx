import { Icon } from "./Icon.js";

export function UncertaintyList({ items }: { items: string[] }) {
  if (items.length === 0) return null;
  return (
    <section aria-labelledby="uncertainty-heading">
      <h3 id="uncertainty-heading" className="section-heading">
        Worth verifying yourself
      </h3>
      <ul className="verify">
        {items.map((item, index) => (
          <li key={index}>
            <Icon name="Question" />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
