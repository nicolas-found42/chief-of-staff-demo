import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { RunSummary } from "@chief-of-staff-demo/shared";
import { SourceBadge, StatusPill } from "../components/StatusPill";
import { formatTime, relativeTime, runTitle } from "../display";
import { api, errorMessage } from "../client";
import type { DriveIntakeStatus } from "@chief-of-staff-demo/shared";
import { useGoogleConnection } from "../useGoogleConnection";
import { usePageFocus } from "../usePageFocus";
import { useTitle } from "../useTitle";

const TERMINAL = new Set(["done", "skipped", "failed"]);

export function RunsPage() {
  useTitle("Runs");
  const headingRef = usePageFocus<HTMLHeadingElement>();
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [intake, setIntake] = useState<DriveIntakeStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [liveReady, setLiveReady] = useState(false);
  /* The connection is the Shell's, and its banner renders above this page
     (ADR-0011). All this page owes it is a refresh on the tick below, since the
     poll here is live in the one window where a Run can reject a grant. */
  const { status: googleStatus, refresh: refreshConnection } = useGoogleConnection();

  const refresh = useCallback(async () => {
    try {
      /* The liveness line rides along with every list refresh: mount, manual
         Refresh, and the active-run interval. Its own failure must not blank
         the list, so it degrades to the last known (or no) status. */
      const [{ runs: next }, nextIntake] = await Promise.all([
        api.listRuns(),
        api.driveIntakeStatus().catch(() => null),
      ]);
      setRuns(next);
      if (nextIntake) {
        setIntake(nextIntake);
      }
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
      <div className="page-header">
        <h1 ref={headingRef} tabIndex={-1}>
          Runs
        </h1>
        {/* aria-disabled rather than disabled, like every other busy control
            here: the pressed button has to survive its own request. */}
        <button type="button" className="action-button" onClick={check} aria-disabled={checking}>
          {checking ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {/* Ticket 12: the liveness line. Remembered facts only — the endpoint
          makes zero Google calls, and after a restart, before the first poll,
          it claims no last-checked time it does not have. Hidden entirely when
          the connection or folder is missing: silence, not a stale promise. */}
      {googleStatus?.state === "connected" && intake?.configured && intake.enabled && (
        <p className="muted" data-testid="intake-liveness">
          Watching {intake.folderName || "your Drive folder"}
          {intake.lastPollAt
            ? ` · last checked ${relativeTime(intake.lastPollAt)}` +
              (intake.lastPollOutcome === "failed" ? " (that check failed)" : "")
            : ""}
          {" · "}
          every {intake.pollIntervalMinutes} min
        </p>
      )}

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
              <th scope="col">Run</th>
              <th scope="col">Outcome</th>
              <th scope="col">When</th>
              <th scope="col">Source</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <tr key={run.id} className="run-row">
                {/* What happened leads: the title is derived at render so
                    legacy runs read the same way, and the raw filename is
                    demoted to metadata (D4). The link stays the keyboard and
                    screen-reader route into the run. */}
                <td className="run-file-name">
                  <Link
                    to={`/runs/${run.id}`}
                    className="run-link"
                    title={run.fileName}
                  >
                    {runTitle(run.fileName)}
                  </Link>
                  <span className="muted run-file-meta">{run.fileName}</span>
                </td>
                <td>
                  <StatusPill status={run.status} connectionCaused={run.connectionCaused} />
                  {run.status === "skipped" && run.skipReason && (
                    <span className="muted skip-reason"> · {run.skipReason}</span>
                  )}
                  {run.status === "done" && run.taskCount !== null && (
                    <span className="muted skip-reason">
                      {" "}
                      ·{" "}
                      {run.taskCount === 1 ? "1 task" : `${run.taskCount} tasks`}
                    </span>
                  )}
                </td>
                <td>
                  <time dateTime={run.createdAt} title={formatTime(run.createdAt)}>
                    {relativeTime(run.createdAt)}
                  </time>
                </td>
                <td>
                  <SourceBadge source={run.source} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
