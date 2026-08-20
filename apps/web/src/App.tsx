import { Link, NavLink, Route, Routes } from "react-router-dom";
import { ConnectionBanner } from "./components/ConnectionBanner";
import { HomePage } from "./pages/HomePage";
import { HotTakePage } from "./pages/HotTakePage";
import { NotFoundPage } from "./pages/NotFoundPage";
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
        {/* The wordmark is the way back to the front door, and it stays outside
            <nav aria-label="Modules">: Home is not a Module (CONTEXT.md), and a
            link in there would both relabel it as one in the accessibility tree
            and add a second candidate to the nav's current-page indicator. A
            plain Link rather than a NavLink for the same reason — the current
            state belongs to the tab bar, and an aria-current with nothing drawn
            for it is exactly the drift the nav styling avoids. */}
        <Link className="app-title" to="/">
          Found42 — Chief of Staff
        </Link>
        <nav aria-label="Modules">
          <NavLink to="/transcript">
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
        {/* Inside <main>, above the outlet: the skip link targets #main, so a
            banner here is the first thing a keyboard user meets after skipping,
            where one in a new row above <main> would be jumped straight over.
            No Module renders it (ADR-0011). */}
        <ConnectionBanner />
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/transcript" element={<RunsPage />} />
          <Route path="/runs/:id" element={<RunDetailPage />} />
          <Route path="/hot-take" element={<HotTakePage />} />
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
