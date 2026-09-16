export function Header() {
  return (
    <header className="app-header">
      <div className="app-header__brand">
        <span className="app-header__brand-mark" aria-hidden="true">
          a/
        </span>
        Agency OS
        <span className="app-header__section">Project intelligence</span>
      </div>
      <div className="app-header__org">
        <span className="org-avatar" aria-hidden="true">
          AD
        </span>
        Acme Digital
      </div>
    </header>
  );
}
