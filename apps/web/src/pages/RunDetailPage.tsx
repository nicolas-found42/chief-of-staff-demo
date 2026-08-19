import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { RunDetail } from "@transcript-tasks/shared";
import { SourceBadge, StatusPill, formatTime } from "../components/StatusPill";
import { api, errorMessage } from "../client";
import { useTitle } from "../useTitle";

const ACTIVE = new Set(["pending", "extracting", "creating-outputs"]);

export function RunDetailPage() {
  const { id } = useParams<{ id: string }>();
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
  const focusedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!detail || !id || focusedFor.current === id) {
      return;
    }
    focusedFor.current = id;
    headingRef.current?.focus();
  }, [detail, id]);

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
          <Link to="/" className="back-link">← All runs</Link>
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

  return (
    <div className="page">
      <p>
        <Link to="/" className="back-link">← All runs</Link>
      </p>
      <h1 className="run-title" ref={headingRef} tabIndex={-1}>
        {detail.fileName}
      </h1>
      <div className="run-meta">
        <span role="status">
          <span className="visually-hidden">Status: </span>
          <StatusPill status={detail.status} />
        </span>
        <SourceBadge source={detail.source} />
        <span className="muted">{formatTime(detail.createdAt)}</span>
        {detail.sourceUrl && (
          <a href={detail.sourceUrl} target="_blank" rel="noreferrer">
            source <span aria-hidden="true">↗</span>
            <span className="visually-hidden"> (opens in a new tab)</span>
          </a>
        )}
        {detail.attempts > 0 && <span className="muted">attempts: {detail.attempts}</span>}
        {detail.failedStage && (
          <span className="bad">failed stage: {detail.failedStage}</span>
        )}
      </div>

      {detail.status === "failed" && (
        <div className="banner banner-error" role="alert">
          {detail.failedStage === "outputs"
            ? "Output creation failed. Connect Google in Settings, then retry."
            : "Extraction failed after 3 attempts."}
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
          <h2>Summary</h2>
          <div className="card">
            <p>{result.summary}</p>
          </div>

          <h2 id="tasks-heading">Tasks ({result.tasks.length})</h2>
          {result.tasks.length > 0 ? (
            /* Focusable for the same reason as the events log below: the
               container scrolls at narrow widths and high zoom, and without a
               tabindex a keyboard user cannot reach the columns it hides
               (WCAG 2.1.1). */
            <div
              className="table-scroll"
              tabIndex={0}
              role="region"
              aria-labelledby="tasks-heading"
            >
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
              <div className="draft-headers">
                <span>
                  <strong>To:</strong> {draft.to || <span className="muted">(no address known)</span>}
                </span>
                <span>
                  <strong>Subject:</strong> {draft.subject}
                </span>
              </div>
              <pre className="draft-body">{draft.body}</pre>
              {draft.reason && <p className="muted">Reason: {draft.reason}</p>}
            </div>
          ))}
          {result.drafts.length === 0 && <p className="muted">No drafts composed.</p>}
        </>
      )}

      <h2 id="events-heading">Events</h2>
      {/* Focusable so the capped-height scroller can be reached and scrolled
          with the keyboard (2.1.1). */}
      <div
        className="events-log"
        tabIndex={0}
        role="region"
        aria-labelledby="events-heading"
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
