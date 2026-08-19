import { NavLink, Route, Routes } from "react-router-dom";
import { NotFoundPage } from "./pages/NotFoundPage";
import { RunDetailPage } from "./pages/RunDetailPage";
import { RunsPage } from "./pages/RunsPage";
import { SettingsPage } from "./pages/SettingsPage";

export function App() {
  return (
    <div className="app-shell">
      {/* Bypass block: off-screen until focused. The landmark set already
          covers 2.4.1 for anyone navigating by landmark, but a magnifier user
          without those shortcuts otherwise re-traverses the header on every
          page. */}
      <a className="skip-link" href="#main">
        Skip to main content
      </a>
      <header className="app-header">
        <div className="app-title">Transcript → Tasks</div>
        <nav>
          <NavLink to="/" end>
            Runs
          </NavLink>
          <NavLink to="/settings">Settings</NavLink>
        </nav>
      </header>
      <main className="app-main" id="main" tabIndex={-1}>
        <Routes>
          <Route path="/" element={<RunsPage />} />
          <Route path="/runs/:id" element={<RunDetailPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </main>
      <footer className="app-footer">
        <span>Drafts are created, mail is never sent.</span>
      </footer>
    </div>
  );
}
