import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { RunDetail } from "@transcript-tasks/shared";
import { SourceBadge, StatusPill, formatTime } from "../components/StatusPill";
import { api, errorMessage } from "../client";

const ACTIVE = new Set(["pending", "extracting", "creating-outputs"]);

export function RunDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);

  const load = useCallback(async () => {
    if (!id) {
      return;
    }
    try {
      setDetail(await api.getRun(id));
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

  const retry = async () => {
    if (!id) {
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
    }
  };

  if (error) {
    return (
      <div className="page">
        <h1>Run</h1>
        <div className="banner banner-error">{error}</div>
        <p>
          <Link to="/">← All runs</Link>
        </p>
      </div>
    );
  }
  if (!detail) {
    return (
      <div className="page">
        <h1>Run</h1>
        <p className="muted">Loading…</p>
      </div>
    );
  }

  const result = detail.result;

  return (
    <div className="page">
      <p>
        <Link to="/">← All runs</Link>
      </p>
      <h1 className="run-title">{detail.fileName}</h1>
      <div className="run-meta">
        <StatusPill status={detail.status} />
        <SourceBadge source={detail.source} />
        <span className="muted">{formatTime(detail.createdAt)}</span>
        {detail.sourceUrl && (
          <a href={detail.sourceUrl} target="_blank" rel="noreferrer">
            source ↗
          </a>
        )}
        {detail.attempts > 0 && <span className="muted">attempts: {detail.attempts}</span>}
        {detail.failedStage && (
          <span className="bad">failed stage: {detail.failedStage}</span>
        )}
      </div>

      {detail.status === "failed" && (
        <div className="banner banner-error">
          {detail.failedStage === "outputs"
            ? "Output creation failed. Connect Google in Settings, then retry."
            : "Extraction failed after 3 attempts."}
          <button onClick={retry} disabled={retrying}>
            {retrying ? "Retrying…" : "Retry"}
          </button>
        </div>
      )}
      {detail.status === "skipped" && detail.skipReason && (
        <div className="banner banner-warn">Not a transcript — {detail.skipReason}</div>
      )}

      {result && (
        <>
          <h2>Summary</h2>
          <div className="card">
            <p>{result.summary}</p>
          </div>

          <h2>Tasks ({result.tasks.length})</h2>
          {result.tasks.length > 0 ? (
            <table className="tasks-table">
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Owner</th>
                  <th>Due</th>
                  <th>Notes</th>
                  <th>Quote</th>
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

      <h2>Events</h2>
      <div className="events-log">
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
        <pre className="artifact-pre">{detail.transcript}</pre>
      </details>
    </div>
  );
}
