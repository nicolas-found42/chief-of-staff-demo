import { NavLink, Route, Routes } from "react-router-dom";
import { HotTakePage } from "./pages/HotTakePage";
import { NotFoundPage } from "./pages/NotFoundPage";
// PROTOTYPE — throwaway route, branch prototype/home-variants. Never merge to main.
import { HomePrototypePage } from "./prototype/HomePrototypePage";
import { RunDetailPage } from "./pages/RunDetailPage";
import { RunsPage } from "./pages/RunsPage";
import { SettingsPage } from "./pages/SettingsPage";
import { useIsLoadedEntry } from "./usePageFocus";

export function App() {
  // Records the history entry the browser loaded, before any route can navigate
  // off it. Asked for here rather than in the pages so the capture cannot depend
  // on which route happened to match first.
  useIsLoadedEntry();

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
        <div className="app-title">Found42 — Chief of Staff</div>
        <nav aria-label="Modules">
          <NavLink to="/" end>
            Transcript → Tasks
          </NavLink>
          <NavLink to="/hot-take">
            Hot Take
          </NavLink>
        </nav>
        <nav aria-label="Settings">
          <NavLink to="/settings">Settings</NavLink>
        </nav>
      </header>
      <main className="app-main" id="main" tabIndex={-1}>
        <Routes>
          <Route path="/" element={<RunsPage />} />
          <Route path="/runs/:id" element={<RunDetailPage />} />
          <Route path="/hot-take" element={<HotTakePage />} />
          <Route path="/settings" element={<SettingsPage />} />
          {/* PROTOTYPE — throwaway. Answers .scratch/shell-home/issues/01. */}
          <Route path="/prototype/home" element={<HomePrototypePage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </main>
      <footer className="app-footer">
        <span>Drafts are created, mail is never sent.</span>
      </footer>
    </div>
  );
}
