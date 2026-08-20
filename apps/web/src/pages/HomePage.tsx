import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { ProviderId, RunSummary } from "@chief-of-staff-demo/shared";
import { api, errorMessage } from "../client";
import { connectionNotice } from "../connectionNotice";
import { homeStatus } from "../homeStatus";
import { useGoogleConnection } from "../useGoogleConnection";
import { useModules } from "../useModules";
import { usePageFocus } from "../usePageFocus";
import { useTitle } from "../useTitle";

const TERMINAL = new Set(["done", "skipped", "failed"]);

/**
 * The Shell's front door: where the workspace stands, and the way into the
 * Modules (ADR-0010).
 *
 * `useTitle(null)` resolves to the bare Shell name, which is identical to the
 * `<title>` in index.html — so opening the front door never re-titles the tab,
 * where `useTitle("Home")` would flash "Chief of Staff" → "Home · Chief of
 * Staff" on every visit to the most-visited route.
 *
 * Home shows no Runs list (that is Transcript's, and a short copy beside the
 * real one is worse than a link), no metrics (a fresh workspace renders them as
 * zeroes, at the one moment Home matters most to someone new) and no drop target
 * (Intake is a Module concern).
 */
export function HomePage() {
  useTitle(null);
  const headingRef = usePageFocus<HTMLHeadingElement>();
  const { status, refresh: refreshConnection } = useGoogleConnection();
  const modules = useModules();
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [provider, setProvider] = useState<ProviderId | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setRuns((await api.listRuns()).runs);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /* Asked once: the provider only changes through Settings, which is a full
     route away, and the poll below has no reason to keep asking. */
  useEffect(() => {
    const load = async () => {
      try {
        setProvider((await api.getConfig()).config.provider);
      } catch (err) {
        setError(errorMessage(err));
      }
    };
    void load();
  }, []);

  const activeCount = runs === null ? 0 : runs.filter((run) => !TERMINAL.has(run.status)).length;

  /* The same rule the runs list uses: an interval that exists only while a Run
     can still change (WCAG 2.2.2). The connection refreshes on the same tick
     rather than on a timer of its own — a grant rejected mid-Run is the one
     event that changes it without passing through Settings, and this poll is
     live in exactly that window (ADR-0011). */
  useEffect(() => {
    if (activeCount === 0) {
      return;
    }
    const timer = setInterval(() => {
      void refresh();
      void refreshConnection();
    }, 3000);
    return () => clearInterval(timer);
  }, [activeCount, refresh, refreshConnection]);

  if (runs === null || provider === null) {
    return (
      <div className="page">
        <h1 ref={headingRef} tabIndex={-1}>
          Home
        </h1>
        {error ? (
          <div className="banner banner-error" role="alert">
            {error}
          </div>
        ) : (
          <p className="muted" role="status">
            Loading…
          </p>
        )}
      </div>
    );
  }

  const notice = connectionNotice(status);
  const { sentence, rows } = homeStatus(runs, provider, notice !== null);

  return (
    <div className="page">
      <h1 ref={headingRef} tabIndex={-1}>
        Home
      </h1>

      {/* Plain text, no links: `.step-link` is a boxed button style, so an
          inline link renders as a button mid-paragraph. */}
      <p className="home-sentence">{sentence}</p>

      {/* The one fact where silence is genuinely ambiguous — an unwarned page
          cannot be told apart from a check that never ran — and this connection
          expires about weekly. Identity only: the expiry warning belongs to the
          Shell banner above, which already reaches this page. */}
      {status?.state === "connected" && (
        <p className="muted home-identity">
          Google connected{status.email ? ` as ${status.email}` : ""}
        </p>
      )}

      {error && (
        <div className="banner banner-error" role="alert">
          {error}
        </div>
      )}

      {/* Omitted entirely when empty, rather than rendering an all-clear: the
          sentence has already said it. The heading is hidden because a sighted
          reader takes the label from that sentence, but nothing associates the
          list with it programmatically — and it puts the rail in the heading
          outline beside "Modules" for heading navigation. */}
      {rows.length > 0 && (
        <>
          <h2 className="visually-hidden">Needs your attention</h2>
          <ul className="home-rail">
            {rows.map((row) => (
              <li key={row.id} className="banner banner-warn">
                <span>{row.text}</span>
                <Link to={row.to} className="step-link">
                  {row.cta}
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}

      <h2>Modules</h2>
      <div className="module-grid">
        {modules.map((module) => (
          <div className="card module-card" key={module.id}>
            <h3>
              <Link to={module.path}>{module.label}</Link>
              {module.status === "planned" && (
                <span className="status-pill status-active">Planned</span>
              )}
            </h3>
            <p className="muted">{module.description}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
