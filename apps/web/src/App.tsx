import { Link, NavLink, Route, Routes } from "react-router-dom";
import { AllRunsPage } from "./pages/AllRunsPage";
import { ConnectionBanner } from "./components/ConnectionBanner";
import { HomePage } from "./pages/HomePage";
import { ContentResearchPage } from "./pages/ContentResearchPage";
import { ContentScoutPage } from "./pages/ContentScoutPage";
import { MeetingsOverviewPage } from "./pages/MeetingsOverviewPage";
import { MeetingBriefPage } from "./pages/MeetingBriefPage";
import { MeetingDebriefDetailPage } from "./pages/MeetingDebriefDetailPage";
import { MeetingDebriefPage } from "./pages/MeetingDebriefPage";
import { NewPersonProfilePage } from "./pages/NewPersonProfilePage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { PeoplePage } from "./pages/PeoplePage";
import { PersonProfileDetailPage } from "./pages/PersonProfileDetailPage";
import { TranscriptReviewPage } from "./pages/TranscriptReviewPage";
import { RunDetailPage } from "./pages/RunDetailPage";
import { SettingsPage } from "./pages/SettingsPage";
import { YoutubePage } from "./pages/YoutubePage";
import { useIsLoadedEntry } from "./usePageFocus";
import { useModules } from "./useModules";

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
        {/* A tab promises function (ADR-0014): the bar renders live, top-level
            Modules only, from the same list Home's cards read. A planned
            Module keeps its route mounted below and is announced from Home
            instead; a Module presented under another Module's surface
            (YouTube Trends under Content Research) is announced on Home and
            entered from its parent's page. */}
        <nav aria-label="Modules">
          {useModules()
            .filter((module) => module.status === "live" && !module.parent)
            .map((module) => (
              <NavLink key={module.id} to={module.path}>
                {module.label}
              </NavLink>
            ))}
        </nav>
        {/* Product areas are explicit (ADR-0043), not derived from the Module
            registry. Person Profiles is a Workspace resource with its own
            product surface, not a Module, so it gets its own nav. */}
        <nav aria-label="Products">
          <NavLink to="/people">Person Profiles</NavLink>
          <NavLink to="/meetings">Meeting Wizard</NavLink>
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
          {/* A Shell page, not a tab: the bar renders Modules (ADR-0014), and
              Home's capped feed links in here for everything older. */}
          <Route path="/runs" element={<AllRunsPage />} />
          <Route path="/runs/:id" element={<RunDetailPage />} />
          {/* YouTube Trends is presented under Content Research (spec:
              /content-research/trends); the legacy top-level route is gone. */}
          <Route path="/content-research/trends" element={<YoutubePage />} />
          <Route path="/content-scout" element={<ContentScoutPage />} />
          1:{" "}
          {/* Meeting Wizard (ADR-0043): Overview plus the sibling Brief
      journey; Brief and Debrief lifecycle state stays separate. The
      legacy /meeting-brief product route is gone — not-found. */}
          <Route path="/meetings" element={<MeetingsOverviewPage />} />
          <Route path="/meetings/brief" element={<MeetingBriefPage />} />
          <Route path="/meetings/brief/:occurrenceKey" element={<MeetingBriefPage />} />
          <Route path="/meeting-debrief" element={<MeetingDebriefPage />} />
          <Route path="/meeting-debrief/:runId" element={<MeetingDebriefDetailPage />} />
          <Route path="/content-research" element={<ContentResearchPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/people" element={<PeoplePage />} />
          <Route path="/people/new" element={<NewPersonProfilePage />} />
          <Route path="/people/:profileId" element={<PersonProfileDetailPage />} />
          <Route path="/people/review" element={<TranscriptReviewPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </main>
      <footer className="app-footer">
        <span>
          Drafts are created, mail is never sent — except Meeting Briefs, which go only to your
          connected account.
        </span>
      </footer>
    </div>
  );
}
