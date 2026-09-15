export function UncertaintyList({ items }: { items: string[] }) {
  if (items.length === 0) return null;
  return (
    <section aria-labelledby="uncertainty-heading">
      <h3 id="uncertainty-heading" className="section-heading">
        Needs verification
      </h3>
      <ul className="uncertainty-list">
        {items.map((item, index) => (
          <li className="uncertainty-item" key={index}>
            <span aria-hidden="true">•</span>
            {item}
          </li>
        ))}
      </ul>
    </section>
  );
}
