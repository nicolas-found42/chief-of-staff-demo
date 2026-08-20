import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { RunSummary } from "@chief-of-staff-demo/shared";
import { SourceBadge, StatusPill, formatTime } from "../components/StatusPill";
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
  const [uploading, setUploading] = useState(false);
  const [checking, setChecking] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [liveReady, setLiveReady] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  /* The connection is the Shell's, and its banner renders above this page
     (ADR-0011). All this page owes it is a refresh on the tick below, since the
     poll here is live in the one window where a Run can reject a grant. */
  const { refresh: refreshConnection } = useGoogleConnection();

  const refresh = useCallback(async () => {
    try {
      const payload = await api.listRuns();
      setRuns(payload.runs);
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
    if (activeCount === 0) {
      return;
    }
    const timer = setInterval(() => {
      void refresh();
      void refreshConnection();
    }, 3000);
    return () => clearInterval(timer);
  }, [activeCount, refresh, refreshConnection]);

  // A live region only announces what arrives after it is mounted; text already
  // present on the first paint is skipped (WCAG 4.1.3). This effect runs after
  // that paint, so the status below is filled in as a change rather than as
  // initial content.
  useEffect(() => {
    setLiveReady(true);
  }, []);

  const upload = async (files: File[]) => {
    if (files.length === 0) {
      return;
    }
    setUploading(true);
    try {
      const { runIds } = await api.upload(files);
      await refresh();
      if (runIds.length === 1) {
        navigate(`/runs/${runIds[0]}`);
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setUploading(false);
    }
  };

  // Runs also arrive from the watch folder and from a Fireflies sync, neither
  // of which involves this tab. Stopping the poll without this would mean an
  // idle list could never show them; it is also the recovery path when the
  // request that would have restarted the poll is the one that failed.
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
        (activeCount === 0 ? " Updates paused — use Check for new runs." : "");

  return (
    <div className="page">
      <div className="page-head">
        <h1 ref={headingRef} tabIndex={-1}>
          Runs
        </h1>
        {/* aria-disabled rather than disabled, like every other busy control
            here: the pressed button has to survive its own request. */}
        <button type="button" onClick={check} aria-disabled={checking}>
          {checking ? "Checking…" : "Check for new runs"}
        </button>
      </div>

      {/* Clicking anywhere in the zone opens the picker — the pointer cursor
          promised that already. The button remains the keyboard route, so this
          is a pointer convenience layered on a real control, not the only way
          in. */}
      <div
        className={`dropzone${dragging ? " dragging" : ""}`}
        data-testid="dropzone"
        onClick={() => inputRef.current?.click()}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          void upload(Array.from(event.dataTransfer.files));
        }}
      >
        {/* The button stays mounted for the whole upload and swaps its label:
            unmounting the control the user just activated drops focus to
            <body> and throws them to the top of the document (WCAG 2.4.3),
            which is the same reason these controls use aria-disabled rather
            than the disabled attribute. */}
        <p>
          <strong>Drop transcripts here</strong> or{" "}
          <button
            type="button"
            className="linklike"
            aria-describedby="upload-formats"
            aria-disabled={uploading}
            onClick={(event) => {
              // The zone's own handler would otherwise open the picker twice.
              event.stopPropagation();
              if (uploading) {
                return;
              }
              inputRef.current?.click();
            }}
          >
            {uploading ? "Uploading…" : "choose files"}
          </button>
        </p>
        {/* The description belongs on the button: the file input is hidden, so
            it computes to display:none and is absent from the accessibility
            tree — anything bound to it is inert (WCAG 3.3.2). */}
        {/* The separators are decoration. Exposed, the list is read as
            ".txt dot .md dot .json…", four times over (WCAG 1.3.1). */}
        <p className="muted" id="upload-formats">
          .txt <span aria-hidden="true">·</span> .md <span aria-hidden="true">·</span> .json
          (Fireflies export) <span aria-hidden="true">·</span> .pdf{" "}
          <span aria-hidden="true">·</span> .docx — up to 10 MB each
        </p>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".txt,.md,.json,.pdf,.docx"
          hidden
          aria-label="Choose transcript files"
          onChange={(event) => {
            void upload(Array.from(event.target.files ?? []));
            event.target.value = "";
          }}
        />
      </div>

      {error && (
        <div className="banner banner-error" role="alert">
          {error}
        </div>
      )}

      <p className="visually-hidden" role="status">
        {liveReady
          ? uploading
            ? "Uploading transcripts…"
            : checking
              ? "Checking for new runs…"
              : listStatus
          : ""}
      </p>

      {runs !== null &&
        (runs.length === 0 ? (
          // The table used to render empty: a caption and five column headers
          // describing rows that did not exist, wrapped in a focusable region,
          // with the actual message stranded outside it (WCAG 1.3.1).
          <p className="muted">No runs yet — drop a transcript to get started.</p>
        ) : (
          /* Focusable so the container can be scrolled with the keyboard at
             narrow widths and high zoom, where the Status and Tasks columns are
             otherwise unreachable (WCAG 2.1.1). No role="region": the only name
             it had was the <h1> above it, so it announced "Runs" a second time
             and put a landmark in the list that led nowhere new. */
          <div className="table-scroll" tabIndex={0}>
            <table data-testid="runs-table">
              <caption className="visually-hidden">
                Transcript runs, newest first. Open a run from the link on its file name.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Created</th>
                  <th scope="col">Source</th>
                  <th scope="col">File</th>
                  <th scope="col">Status</th>
                  <th scope="col">Tasks</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr
                    key={run.id}
                    data-testid="run-row"
                    data-run-id={run.id}
                    className="run-row"
                    onClick={() => {
                      // A press that ends with text selected was a drag to
                      // select, not a click on the row: navigating would discard
                      // the selection and remove the "move away to abort" escape
                      // a pointer user is entitled to (WCAG 2.5.2).
                      if (!window.getSelection()?.isCollapsed) {
                        return;
                      }
                      navigate(`/runs/${run.id}`);
                    }}
                  >
                    <td>{formatTime(run.createdAt)}</td>
                    <td>
                      <SourceBadge source={run.source} />
                    </td>
                    <td className="run-file-name">
                      {/* The link was on the timestamp, which named every link
                          in the table by its creation second — two runs created
                          in the same second produced identically named links to
                          different runs, and none of them could be addressed by
                          voice. The filename is the name a person would use
                          (2.4.4, 2.4.9), and putting the link on it rather than
                          in an aria-label avoids the double announcement that
                          got the previous label removed. */}
                      <Link
                        to={`/runs/${run.id}`}
                        className="run-link"
                        // The row navigates as well; without this the same
                        // click would be handled twice. The link needs no
                        // selection guard of its own: a press that begins on it
                        // starts no selection, and one that begins outside it
                        // fires its click on the shared ancestor, where the
                        // row's guard is already watching.
                        onClick={(event) => event.stopPropagation()}
                      >
                        {run.fileName || "Untitled transcript"}
                      </Link>
                    </td>
                    <td>
                      <StatusPill status={run.status} />
                      {!TERMINAL.has(run.status) && (
                        <span className="muted" aria-hidden="true">
                          {" "}
                          …
                        </span>
                      )}
                    </td>
                    <td>{run.taskCount ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
    </div>
  );
}
