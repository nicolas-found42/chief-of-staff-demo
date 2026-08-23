import { useEffect, useState } from "react";
import type { ExtractionResult, RunDetail } from "@chief-of-staff-demo/shared";
import { ApiError, api } from "../../client";

/**
 * The transcript Module's view of one of its Runs: the receipt, the tasks it
 * created in Google, the drafts it prepared, and the transcript it read. The
 * Shell renders the half above this — status, Stages, attempts, the timeline,
 * the summary line — identically for every Module, and reads inside this result
 * nowhere.
 */
export function TranscriptResultView({ detail }: { detail: RunDetail }) {
  const [transcript, setTranscript] = useState<string | null>(null);

  useEffect(() => {
    setTranscript(null);
  }, [detail.id]);

  useEffect(() => {
    if (transcript !== null) {
      return;
    }
    let cancelled = false;
    void api
      .getArtifact(detail.id, "transcript.txt")
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
  }, [detail.id, transcript]);

  const result = detail.result as ExtractionResult | null;
  // A skipped run carries an empty summary. Rendering the heading and card
  // anyway promised a section that had nothing in it (WCAG 1.3.1).
  const summary = result?.summary.trim() ?? "";
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
    <>
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

      {result && (
        <>
          <h2>Tasks ({result.tasks.length})</h2>
          <p className="muted">
            {createdTaskCount === result.tasks.length
              ? `All ${createdTaskCount === 1 ? "1 task was" : `${createdTaskCount} tasks were`} created in Google Tasks.`
              : `${createdTaskCount} of ${result.tasks.length} were created in Google Tasks.`}
          </p>
          {result.tasks.length > 0 ? (
            /* Focusable for the same reason as the events log: the container
               scrolls at narrow widths and high zoom, and without a tabindex a
               keyboard user cannot reach the columns it hides (WCAG 2.1.1). No
               role="region" — the only name available to it is the heading
               directly above, so the landmark added a second entry to the
               landmark list that said what the heading already said. */
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

      <h2>Transcript</h2>
      <pre className="artifact-pre" tabIndex={0} role="region" aria-label="Transcript text">
        {transcript ?? ""}
      </pre>
    </>
  );
}
