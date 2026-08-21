import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { RunSummary } from "@chief-of-staff-demo/shared";
import { StatusPill, formatTime } from "../components/StatusPill";
import { api, errorMessage } from "../client";
import { useGoogleConnection } from "../useGoogleConnection";
import { usePageFocus } from "../usePageFocus";
import { useTitle } from "../useTitle";

const TERMINAL = new Set(["done", "skipped", "failed"]);

export function RunsPage() {
  useTitle("Runs");
  const headingRef = usePageFocus<HTMLHeadingElement>();
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [liveReady, setLiveReady] = useState(false);
  /* The connection is the Shell's, and its banner renders above this page
     (ADR-0011). All this page owes it is a refresh on the tick below, since the
     poll here is live in the one window where a Run can reject a grant. */
  const { refresh: refreshConnection } = useGoogleConnection();

  const refresh = useCallback(async () => {
    try {
      const { runs: next } = await api.listRuns();
      setRuns(next);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const activeCount = runs === null ? 0 : runs.filter((run) => !TERMINAL.has(run.status)).length;

  // The list used to auto-update every 3s for as long as it was open, with no
  // way to pause or stop it and nothing to show for it once every run was
  // terminal (WCAG 2.2.2). The interval now exists only while a run can still
  // change, which is what RunDetailPage already does.
  //
  // activeCount is a number, not the array, so a poll that changes nothing does
  // not tear down and rebuild its own interval.
  useEffect(() => {
    if (activeCount === 0) return;
    const id = setInterval(() => {
      void refresh();
      void refreshConnection();
    }, 3000);
    return () => clearInterval(id);
  }, [activeCount, refresh, refreshConnection]);

  // A live region only announces what arrives after it is mounted; text already
  // present on the first paint is skipped (WCAG 4.1.3). This effect runs after
  // that paint, so the status below is filled in as a change rather than as
  // initial content.
  useEffect(() => {
    setLiveReady(true);
  }, []);

  // Runs arrive from the Drive folder poll, not from this tab. Stopping the poll
  // without this would mean an idle list could never show them; it is also the
  // recovery path when the request that would have restarted the poll is the one
  // that failed.
  const check = async () => {
    if (checking) {
      return;
    }
    setChecking(true);
    try {
      await refresh();
    } finally {
      setChecking(false);
    }
  };

  // Recomputed on every poll, but the string only changes when the counts do,
  // so the live region stays quiet while nothing is happening. When the poll
  // stops, it says so: an auto-updating region that goes still without a word
  // is indistinguishable from one that is broken.
  const listStatus =
    runs === null
      ? "Loading runs…"
      : `${runs.length} run${runs.length === 1 ? "" : "s"}, ${activeCount} in progress.` +
        (activeCount === 0 ? " Updates paused — use Refresh." : "");

  return (
    <div className="page">
      <div className="page-head">
        <h1 ref={headingRef} tabIndex={-1}>
          Runs
        </h1>
        {/* aria-disabled rather than disabled, like every other busy control
            here: the pressed button has to survive its own request. */}
        <button type="button" onClick={check} aria-disabled={checking}>
          {checking ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      <p className="muted">
        Transcripts are read from your Google Drive folder. Choose it in <Link to="/settings">Settings → Drive transcripts</Link> and click <strong>Sync now</strong> if you don&apos;t want to wait for the next poll.
      </p>

      {error && (
        <div className="banner banner-error" role="alert">
          {error}
        </div>
      )}

      <p className="visually-hidden" role="status">
        {liveReady ? (checking ? "Checking for new runs…" : listStatus) : ""}
      </p>

      {runs === null ? (
        <p className="muted" role="status">
          Loading…
        </p>
      ) : runs.length === 0 ? (
        <div className="card">
          <p className="muted">No runs yet. Add a transcript to your Drive folder and it will appear here.</p>
          <p className="muted">Supported: .txt, .md, .json, .jsonc, .pdf, .docx, and native Google Docs.</p>
        </div>
      ) : (
        <table className="runs-table" data-testid="runs-table">
          <thead>
            <tr>
              <th>File</th>
              <th>Status</th>
              <th>Created</th>
              <th>Tasks</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <tr key={run.id} className="run-row">
                <td className="run-file-name">
                  <Link
                    to={`/runs/${run.id}`}
                    className="run-link"
                    // The entire row is clickable for pointer users, but the
                    // filename link is the keyboard route and the screen-reader
                    // name. A click that originates on the link itself must not
                    // be handled twice.
                    onClick={(event) => event.stopPropagation()}
                  >
                    {run.fileName || "Untitled transcript"}
                  </Link>
                </td>
                <td>
                  <StatusPill status={run.status} />
                </td>
                <td>{formatTime(run.createdAt)}</td>
                <td>{run.taskCount ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
