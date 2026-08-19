import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { RunDetail } from "@transcript-tasks/shared";
import {
  SourceBadge,
  StatusPill,
  formatTime,
  stageLabel,
} from "../components/StatusPill";
import { api, errorMessage } from "../client";
import { useIsLoadedEntry } from "../usePageFocus";
import { useTitle } from "../useTitle";

const ACTIVE = new Set(["pending", "running"]);

export function RunDetailPage() {
  const { id } = useParams<{ id: string }>();
  const loadedEntry = useIsLoadedEntry();
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const retryRef = useRef<HTMLButtonElement>(null);

  useTitle(detail?.fileName ?? "Run");

  const load = useCallback(async () => {
    if (!id) {
      return;
    }
    try {
      const next = await api.getRun(id);
      setDetail(next);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!detail || !ACTIVE.has(detail.status)) {
      return;
    }
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, [detail, load]);

  // Arriving at a run moves focus to its heading, so keyboard users continue
  // from the new page instead of the top of the document (2.4.3). The ref
  // guard keeps the 3s poll from stealing focus back on every refresh.
  //
  // The entry the browser loaded is exempt, for the reason usePageFocus gives:
  // focus already sits above the skip link there, and moving it down to the
  // heading puts the skip link, both nav links and "All runs" permanently
  // behind the user. This is the app's most bookmarked and most shared route,
  // so that is the load path it matters most on.
  const focusedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!detail || !id || focusedFor.current === id) {
      return;
    }
    focusedFor.current = id;
    if (!loadedEntry) {
      headingRef.current?.focus();
    }
  }, [detail, id, loadedEntry]);

  const retry = async () => {
    if (!id || retrying) {
      return;
    }
    setRetrying(true);
    try {
      await api.retry(id);
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setRetrying(false);
      setRetryCount((count) => count + 1);
    }
  };

  // The Retry button lives inside the failure banner, which unmounts as soon as
  // the run leaves `failed` — and the whole view is replaced if the retry threw.
  // Either way focus would be left on <body>. This runs after the commit, when
  // the ref reflects whether the button actually survived (WCAG 2.4.3).
  useEffect(() => {
    if (retryCount === 0) {
      return;
    }
    if (!retryRef.current?.isConnected) {
      headingRef.current?.focus();
    }
  }, [retryCount]);

  // Every branch carries headingRef so focus always has somewhere to land, no
  // matter which view a failed action leaves behind. Only one renders at a time.
  if (error) {
    return (
      <div className="page">
        <h1 ref={headingRef} tabIndex={-1}>
          Run
        </h1>
        <div className="banner banner-error" role="alert">
          {error}
        </div>
        <p>
          <Link to="/" className="back-link">
            <span aria-hidden="true">←</span> All runs
          </Link>
        </p>
      </div>
    );
  }
  if (!detail) {
    return (
      <div className="page">
        <h1 ref={headingRef} tabIndex={-1}>
          Run
        </h1>
        <p className="muted" role="status">
          Loading…
        </p>
      </div>
    );
  }

  const result = detail.result;
  // A skipped run carries an empty summary. Rendering the heading and card
  // anyway promised a section that had nothing in it (WCAG 1.3.1).
  const summary = result?.summary.trim() ?? "";

  return (
    <div className="page">
      <p>
        <Link to="/" className="back-link">
          {/* Decorative: exposed, it is read as "left arrow" before the link
              text, the same reason the ↗ below is hidden (WCAG 1.3.1). */}
          <span aria-hidden="true">←</span> All runs
        </Link>
      </p>
      <h1 className="run-title" ref={headingRef} tabIndex={-1}>
        {detail.fileName}
      </h1>
      {/* The gap between these items is flex `gap`, which carries no text, and
          JSX strips the newline-only nodes between the elements — so the row
          flattened to "Status: failedupload8/18/2026, 10:20:14 PMattempts: 1".
          Each item now names itself and opens with a comma: a real character
          that cannot be collapsed away like a bare space between flex children
          can, and one that reads as a pause rather than a word (WCAG 1.3.1). */}
      <div className="run-meta">
        <span role="status">
          <span className="visually-hidden">Status: </span>
          <StatusPill status={detail.status} />
        </span>
        <span>
          <span className="visually-hidden">, Source: </span>
          <SourceBadge source={detail.source} />
        </span>
        <span className="muted">
          <span className="visually-hidden">, Created: </span>
          {formatTime(detail.createdAt)}
        </span>
        {detail.sourceUrl && (
          <a href={detail.sourceUrl} target="_blank" rel="noreferrer">
            <span className="visually-hidden">, </span>
            source <span aria-hidden="true">↗</span>
            <span className="visually-hidden"> (opens in a new tab)</span>
          </a>
        )}
        {detail.attempts > 0 && (
          <span className="muted">
            <span className="visually-hidden">, </span>Attempts: {detail.attempts}
          </span>
        )}
        {detail.failedStage && (
          <span className="bad">
            <span className="visually-hidden">, </span>Failed during {stageLabel(detail.failedStage)}
          </span>
        )}
      </div>

      {detail.status === "failed" && (
        <div className="banner banner-error" role="alert">
          {detail.failureHint ?? "This run failed."}
          {/* aria-disabled, not disabled: a disabled button is blurred and
              dropped from the tab order the moment it is pressed. */}
          <button
            type="button"
            ref={retryRef}
            onClick={retry}
            aria-disabled={retrying}
          >
            {retrying ? "Retrying…" : "Retry"}
          </button>
        </div>
      )}
      {detail.status === "skipped" && detail.skipReason && (
        <div className="banner banner-warn" role="status">
          Not a transcript — {detail.skipReason}
        </div>
      )}

      {result && (
        <>
          {summary && (
            <>
              <h2>Summary</h2>
              <div className="card">
                <p>{summary}</p>
              </div>
            </>
          )}

          <h2>Tasks ({result.tasks.length})</h2>
          {result.tasks.length > 0 ? (
            /* Focusable for the same reason as the events log below: the
               container scrolls at narrow widths and high zoom, and without a
               tabindex a keyboard user cannot reach the columns it hides
               (WCAG 2.1.1). No role="region" — the only name available to it is
               the heading directly above, so the landmark added a second entry
               to the landmark list that said what the heading already said. */
            <div className="table-scroll" tabIndex={0}>
              <table className="tasks-table">
                <caption className="visually-hidden">
                  Tasks extracted from this transcript
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Title</th>
                    <th scope="col">Owner</th>
                    <th scope="col">Due</th>
                    <th scope="col">Notes</th>
                    <th scope="col">Quote</th>
                  </tr>
                </thead>
                <tbody>
                  {result.tasks.map((task, index) => (
                    <tr key={index}>
                      <td>{task.title}</td>
                      <td>{task.owner ?? "—"}</td>
                      <td>{task.due ?? "—"}</td>
                      <td>{task.notes ?? ""}</td>
                      <td className="muted">{task.sourceQuote ? `“${task.sourceQuote}”` : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="muted">No tasks extracted.</p>
          )}

          <h2>Drafts ({result.drafts.length})</h2>
          {result.drafts.map((draft, index) => (
            <div key={index} className="card draft-card">
              {/* A <strong> beside its value is a label only to someone who can
                  see the two are adjacent. dt/dd makes the pairing programmatic
                  (WCAG 1.3.1). */}
              <dl className="draft-headers">
                <dt>To:</dt>
                <dd>{draft.to || <span className="muted">(no address known)</span>}</dd>
                <dt>Subject:</dt>
                <dd>{draft.subject}</dd>
              </dl>
              <pre className="draft-body">{draft.body}</pre>
              {draft.reason && <p className="muted">Reason: {draft.reason}</p>}
            </div>
          ))}
          {result.drafts.length === 0 && <p className="muted">No drafts composed.</p>}
        </>
      )}

      <h2 id="events-heading">Events</h2>
      {/* The log prints stage names and raw JSON details. That is what it is
          for, but a region users can navigate into should say so before they
          arrive rather than leave them to work it out from the contents. */}
      <p className="muted" id="events-note">
        Diagnostic record of the pipeline, oldest first. Technical detail is shown as raw JSON.
      </p>
      {/* Focusable so the capped-height scroller can be reached and scrolled
          with the keyboard (2.1.1). */}
      <div
        className="events-log"
        tabIndex={0}
        role="region"
        aria-labelledby="events-heading"
        aria-describedby="events-note"
      >
        {detail.events.map((event, index) => (
          <div key={index} className="event-row">
            <span className="muted">{formatTime(event.at)}</span> <strong>{event.type}</strong>
            {event.detail ? <span className="muted"> {JSON.stringify(event.detail)}</span> : null}
          </div>
        ))}
      </div>

      <h2>Transcript</h2>
      <details>
        <summary className="muted">Show transcript text</summary>
        <pre
          className="artifact-pre"
          tabIndex={0}
          role="region"
          aria-label="Transcript text"
        >
          {detail.transcript}
        </pre>
      </details>
    </div>
  );
}
