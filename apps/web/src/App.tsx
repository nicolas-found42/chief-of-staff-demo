import { useCallback, useState } from "react";
import { HashRouter, NavLink, Route, Routes } from "react-router-dom";
import { ApiClient } from "./api/client";
import { SetupPage } from "./pages/SetupPage";
import { RunsPage } from "./pages/RunsPage";
import { RunDetailPage } from "./pages/RunDetailPage";
import { ArtifactsPage } from "./pages/ArtifactsPage";
import { SettingsPage } from "./pages/SettingsPage";

const COMMIT_SHA = (typeof process !== "undefined" && process.env?.VITE_UI_COMMIT_SHA) || "dev";

export function App() {
  const [client] = useState(() => new ApiClient());
  const [paired, setPaired] = useState(() => client.token !== null);
  const [serviceInfo, setServiceInfo] = useState<{ version: string; protocol: number } | null>(null);

  const onPaired = useCallback(() => {
    setPaired(true);
  }, []);

  return (
    <HashRouter>
      <div className="app-shell">
        <header className="app-header">
          <span className="app-title">Chief of Staff</span>
          <nav aria-label="Primary">
            <NavLink to="/setup" className={({ isActive }) => (isActive ? "active" : "")}>
              Setup
            </NavLink>
            <NavLink to="/runs" className={({ isActive }) => (isActive ? "active" : "")}>
              Runs
            </NavLink>
            <NavLink to="/artifacts" className={({ isActive }) => (isActive ? "active" : "")}>
              Artifacts
            </NavLink>
            <NavLink to="/settings" className={({ isActive }) => (isActive ? "active" : "")}>
              Settings
            </NavLink>
          </nav>
        </header>
        <main className="app-main">
          <Routes>
            <Route
              path="/setup"
              element={<SetupPage client={client} onPaired={onPaired} onServiceInfo={setServiceInfo} />}
            />
            <Route path="/runs" element={<RunsPage client={client} />} />
            <Route path="/runs/:runId" element={<RunDetailPage client={client} />} />
            <Route path="/artifacts" element={<ArtifactsPage client={client} />} />
            <Route
              path="/settings"
              element={<SettingsPage client={client} serviceInfo={serviceInfo} />}
            />
            <Route
              path="*"
              element={
                <section className="page">
                  <h1>Not found</h1>
                  <p>
                    <a href="#/runs">Go to Runs</a>
                  </p>
                </section>
              }
            />
          </Routes>
        </main>
        <footer className="app-footer">
          <span data-testid="ui-commit-sha">UI {COMMIT_SHA}</span>
          <span data-testid="service-version">
            {serviceInfo
              ? `Service ${serviceInfo.version} (protocol ${serviceInfo.protocol})`
              : `Service ${paired ? "unknown" : "not connected"}`}
          </span>
        </footer>
      </div>
    </HashRouter>
  );
}
