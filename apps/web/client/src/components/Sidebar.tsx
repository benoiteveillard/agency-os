export function Sidebar() {
  return (
    <nav className="app-sidebar" aria-label="Projects">
      <div className="app-sidebar__label">Projects</div>
      <ul className="project-nav">
        <li className="project-nav__item" aria-current="page">
          <span className="project-nav__dot" aria-hidden="true" />
          Acme Website Migration
        </li>
      </ul>
    </nav>
  );
}
