import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { ExtractionResult, RunDetail } from "@chief-of-staff-demo/shared";
import { IntakeBadge, StatusPill } from "../components/StatusPill";
import { buildTimeline, formatDuration, formatTime, stageLabel } from "../display";
import { ApiError, api, errorMessage } from "../client";
import { useIsLoadedEntry } from "../usePageFocus";
import { useTitle } from "../useTitle";

const ACTIVE = new Set(["pending", "running"]);

export function RunDetailPage() {
  const { id } = useParams<{ id: string }>();
  const loadedEntry = useIsLoadedEntry();
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [transcript, setTranscript] = useState<string | null>(null);
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

  useEffect(() => {
    setTranscript(null);
  }, [id]);

  useEffect(() => {
    if (!detail || !id || transcript !== null) {
      return;
    }
    let cancelled = false;
    void api
      .getArtifact(id, "transcript.txt")
      .then((text) => {
        if (!cancelled) {
          setTranscript(text);
        }
      })
      .catch((err) => {
        if (cancelled) {
          return;
        }
        if (err instanceof ApiError && err.status === 404) {
          return;
        }
        // Other errors are ignored; the next detail poll will retry while null.
      });
    return () => {
      cancelled = true;
    };
  }, [detail, id, transcript]);

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
          <Link to="/transcript" className="back-link">
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

  const result = detail.result as ExtractionResult | null;
  // A skipped run carries an empty summary. Rendering the heading and card
  // anyway promised a section that had nothing in it (WCAG 1.3.1).
  const summary = result?.summary.trim() ?? "";
  const timeline = buildTimeline(detail.events, result);
  const completedStages = timeline.filter((entry) => entry.state === "done");
  const failedEntry = timeline.find((entry) => entry.state === "failed");
  /* The transcript Module's stage sequence (ADR-0003): a stage the timeline
     never met, past the one that failed, did not run. Presentation only — the
     server owns the retry policy this mirrors. */
  const STAGE_SEQUENCE = ["convert", "extract", "outputs"];
  const notCompleted: string[] = [];
  if (failedEntry) {
    notCompleted.push(`${failedEntry.label} did not finish.`);
  }
  for (const stage of STAGE_SEQUENCE) {
    if (!timeline.some((entry) => entry.stage === stage)) {
      notCompleted.push(`${stageLabel(stage)} never ran.`);
    }
  }
  /* Mirrors Pipeline.retryRun's policy: a convert failure has nothing cached
     to resume from. */
  const retryable =
    detail.status === "failed" && detail.failedStage !== null && detail.failedStage !== "convert";
  /* The failure records its cause additively (D6); a legacy meta without the
     marker reads — truthfully — as an ordinary failure. */
  const connectionCaused = detail.connectionCaused === true;
  /* The receipt (D9): counts and links come from the event log — the record —
     never from re-deriving what the pipeline must have done. */
  const createdTaskCount = detail.events.filter((e) => e.type === "google_task_created").length;
  const createdDraftCount = detail.events.filter((e) => e.type === "gmail_draft_created").length;
  const notDone = detail.events
    .filter((e) => e.type === "google_task_error" || e.type === "gmail_draft_error")
    .map((e) => {
      const what = e.detail?.title ?? e.detail?.subject;
      return {
        what: typeof what === "string" ? what : "An item",
        kind: e.type === "google_task_error" ? "task" : "draft",
        why: typeof e.detail?.error === "string" ? e.detail.error : "it could not be created",
      };
    });
  /* Deep links: Google returned each task's webViewLink at creation time, so
     the URL is Google's own, not one this app guessed. Queued per title and
     consumed in order, so duplicate titles still pair correctly. Rebuilt every
     render, so the consume is safe. */
  const taskLinkQueues = new Map<string, string[]>();
  for (const event of detail.events) {
    if (event.type !== "google_task_created") {
      continue;
    }
    const title = event.detail?.title;
    if (typeof title !== "string") {
      continue;
    }
    const link = event.detail?.webViewLink;
    const queue = taskLinkQueues.get(title) ?? [];
    if (typeof link === "string") {
      queue.push(link);
    }
    taskLinkQueues.set(title, queue);
  }

  return (
    <div className="page">
      <p>
        <Link to="/transcript" className="back-link">
          {/* Decorative: exposed, it is read as "left arrow" before the link
              text, the same reason the ↗ below is hidden (WCAG 1.3.1). */}
          <span aria-hidden="true">←</span> All runs
        </Link>
      </p>
      <h1 className="run-title" ref={headingRef} tabIndex={-1}>
        {detail.fileName ?? detail.id}
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
          <StatusPill status={detail.status} connectionCaused={detail.connectionCaused} />
        </span>
        <span>
          <span className="visually-hidden">, Source: </span>
          <IntakeBadge intake={detail.intake} />
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
          {/* Impact first (D10): the plain-language cause, then what landed in
              the world versus what did not, then the way out. Retry resumes
              from the failed stage — that semantics already exist; this is
              presentation only. */}
          <div className="failure-impact">
            <p className="failure-cause">
              {detail.failureHint ?? "This run failed."}
            </p>
            {completedStages.length > 0 && (
              <p>
                Already completed:{" "}
                {completedStages.map((entry) => entry.label).join(", ")}.
              </p>
            )}
            {notCompleted.length > 0 && (
              <p>Not completed: {notCompleted.join(" ")}</p>
            )}
          </div>
          <div className="field-row">
            {/* aria-disabled, not disabled: a disabled button is blurred and
                dropped from the tab order the moment it is pressed. */}
            {retryable && (
              <button
                type="button"
                className="action-button"
                ref={retryRef}
                onClick={retry}
                aria-disabled={retrying}
              >
                {retrying ? "Retrying…" : "Retry"}
              </button>
            )}
            {connectionCaused && (
              <Link to="/settings" className="action-button step-link">
                Reconnect
              </Link>
            )}
          </div>
        </div>
      )}
      {detail.status === "skipped" && detail.skipReason && (
        <div className="banner banner-warn" role="status">
          Not a transcript — {detail.skipReason}
        </div>
      )}
      {/* The receipt (D9): what came in, what was concluded, what was created
          in the world, what was not. Renders whatever the run has — a skipped
          or failed run still gets came-in and not-done. */}
      <div className="card receipt">
        <dl className="receipt-grid">
          <div className="receipt-row">
            <dt>Came in</dt>
            <dd>
              {detail.fileName ?? detail.id}
              {detail.sourceUrl && (
                <>
                  {" — "}
                  <a href={detail.sourceUrl} target="_blank" rel="noreferrer">
                    in Drive<span className="visually-hidden"> (opens in a new tab)</span>
                  </a>
                </>
              )}
            </dd>
          </div>
          {summary && (
            <div className="receipt-row">
              <dt>Concluded</dt>
              <dd>{summary}</dd>
            </div>
          )}
          <div className="receipt-row">
            <dt>Created</dt>
            <dd>
              {detail.status === "skipped" && !result
                ? "Nothing — the file was not a transcript."
                : detail.status === "failed" && createdTaskCount + createdDraftCount === 0
                  ? "Nothing — the run did not reach output creation."
                  : `${createdTaskCount === 1 ? "1 task" : `${createdTaskCount} tasks`} in Google Tasks, ${
                      createdDraftCount === 1 ? "1 Gmail draft" : `${createdDraftCount} Gmail drafts`
                    } prepared — nothing was sent.`}
            </dd>
          </div>
          <div className="receipt-row">
            <dt>Not done</dt>
            <dd>
              {notDone.length === 0 ? (
                "Nothing outstanding."
              ) : (
                <ul className="not-done-list">
                  {notDone.map((item, index) => (
                    <li key={index}>
                      {item.what} — {item.kind} not created: {item.why}
                    </li>
                  ))}
                </ul>
              )}
            </dd>
          </div>
        </dl>
      </div>

      {/* The default view answers "what did my chief of staff do?" before
          "what did the engine do?" (D8): one entry per Stage, derived at
          render from the append-only log. */}
      {timeline.length > 0 && (
        <>
          <h2>What happened</h2>
          <ol className="timeline" aria-label="Stage timeline">
            {timeline.map((entry) => (
              <li key={entry.stage} className="timeline-row">
                <div className="timeline-head">
                  <span className="timeline-name">{entry.label}</span>
                  <span
                    className={`status-badge ${
                      entry.state === "failed"
                        ? "status-failed"
                        : entry.state === "running"
                          ? "status-active"
                          : "status-done"
                    }`}
                  >
                    {entry.state === "failed" ? "Failed" : entry.state === "running" ? "Running" : "Done"}
                  </span>
                  {entry.durationMs !== null && (
                    <span className="muted">{formatDuration(entry.durationMs)}</span>
                  )}
                </div>
                {entry.outcome && <p className="timeline-outcome">{entry.outcome}</p>}
              </li>
            ))}
          </ol>
        </>
      )}

      {result && (
        <>
          <h2>Tasks ({result.tasks.length})</h2>
          <p className="muted">
            {createdTaskCount === result.tasks.length
              ? `All ${createdTaskCount === 1 ? "1 task was" : `${createdTaskCount} tasks were`} created in Google Tasks.`
              : `${createdTaskCount} of ${result.tasks.length} were created in Google Tasks.`}
          </p>
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
                  {result.tasks.map((task, index) => {
                    const queue = taskLinkQueues.get(task.title);
                    const link = queue?.shift() ?? null;
                    return (
                      <tr key={index}>
                        <td>
                          {task.title}
                          {link && (
                            <>
                              {" — "}
                              <a href={link} target="_blank" rel="noreferrer">
                                Open in Google Tasks
                                <span className="visually-hidden"> (opens in a new tab)</span>
                              </a>
                            </>
                          )}
                        </td>
                        <td>{task.owner ?? "—"}</td>
                        <td>{task.due ?? "—"}</td>
                        <td>{task.notes ?? ""}</td>
                        <td className="muted">{task.sourceQuote ? `“${task.sourceQuote}”` : ""}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="muted">No tasks extracted.</p>
          )}

          <h2>Drafts ({result.drafts.length})</h2>
          {result.drafts.length > 0 && (
            <p className="muted">
              Prepared{" "}
              {result.drafts.length === 1 ? "1 Gmail draft" : `${result.drafts.length} Gmail drafts`} —
              nothing was sent.
            </p>
          )}
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

      {/* Everything engine-facing sits one disclosure level down (D8). The
          events log and transcript render exactly as they did — they are the
          record, not a summary of it. */}
      <details className="disclosure">
        <summary>Technical details</summary>
        <div className="disclosure-body">
          <h2 id="events-heading">Events</h2>
          {/* The log prints stage names and raw JSON details. That is what it
              is for, but a region users can navigate into should say so before
              they arrive rather than leave them to work it out from the
              contents. */}
          <p className="muted" id="events-note">
            Diagnostic record of the pipeline, oldest first. Technical detail is shown as raw JSON.
          </p>
          {/* Focusable so the capped-height scroller can be reached and
              scrolled with the keyboard (2.1.1). */}
          <div
            className="events-log"
            tabIndex={0}
            role="region"
            aria-labelledby="events-heading"
            aria-describedby="events-note"
          >
            {detail.events.map((event, index) => (
              <div key={index} className="event-row">
                <span className="muted">{formatTime(event.at)}</span>{" "}
                <strong>{event.type}</strong>
                {event.detail ? (
                  <span className="muted"> {JSON.stringify(event.detail)}</span>
                ) : null}
              </div>
            ))}
          </div>

          <h2>Transcript</h2>
          <pre
            className="artifact-pre"
            tabIndex={0}
            role="region"
            aria-label="Transcript text"
          >
            {transcript ?? ""}
          </pre>
        </div>
      </details>
    </div>
  );
}
