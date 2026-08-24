import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { IdeaContentType, IdeaEngineIndex } from "@chief-of-staff-demo/shared";
import { IDEA_CONTENT_TYPES } from "@chief-of-staff-demo/shared";
import { api } from "../client";
import { usePageFocus } from "../usePageFocus";
import { useTitle } from "../useTitle";

export function IdeaEnginePage() {
  useTitle("Idea Engine");
  usePageFocus();
  const [data, setData] = useState<IdeaEngineIndex | null>(null);
  const [filter, setFilter] = useState<IdeaContentType | "all">("all");
  const [backfilling, setBackfilling] = useState(false);
  const [backfillResult, setBackfillResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .ideaEngineIdeas()
      .then(setData)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  const onBackfill = async () => {
    setBackfilling(true);
    setBackfillResult(null);
    try {
      const res = await api.ideaEngineBackfill();
      setBackfillResult(`Backfill: ${res.created} created, ${res.skipped} skipped`);
      const refreshed = await api.ideaEngineIdeas();
      setData(refreshed);
    } catch (err) {
      setBackfillResult(err instanceof Error ? err.message : String(err));
    } finally {
      setBackfilling(false);
    }
  };

  if (error) {
    return (
      <section className="page">
        <h1>Idea Engine</h1>
        <p className="field-error">{error}</p>
      </section>
    );
  }

  if (!data) {
    return (
      <section className="page">
        <h1>Idea Engine</h1>
        <p className="muted">Loading ideas…</p>
      </section>
    );
  }

  const filteredRuns =
    filter === "all"
      ? data.runs
      : data.runs
          .map((run) => ({
            ...run,
            ideas: run.ideas.filter((idea) => idea.ContentType === filter),
          }))
          .filter((run) => run.ideas.length > 0);

  return (
    <section className="page">
      <h1>Idea Engine</h1>
      <p className="muted">Content Ideas extracted from transcripts, grouped by meeting, filterable by type.</p>

      <div className="toolbar">
        <label>
          Filter by type:{" "}
          <select value={filter} onChange={(e) => setFilter(e.target.value as IdeaContentType | "all")}>
            <option value="all">All types</option>
            {IDEA_CONTENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <button type="button" onClick={onBackfill} disabled={backfilling}>
          {backfilling ? "Backfilling…" : "Backfill historical transcripts"}
        </button>
        {backfillResult && <span className="muted">{backfillResult}</span>}
      </div>

      {filteredRuns.length === 0 ? (
        <p className="muted">No ideas yet. New transcripts after live are handled automatically; use backfill for history.</p>
      ) : (
        filteredRuns.map((run) => (
          <section key={run.runId} className="card">
            <h2>
              <Link to={`/runs/${run.runId}`}>{run.fileName ?? run.runId}</Link>
              {run.summary && <span className="muted"> — {run.summary}</span>}
            </h2>
            <ul>
              {run.ideas.map((idea, idx) => (
                <li key={`${idea.Title}-${idx}`}>
                  <strong>{idea.Title}</strong> <em>({idea.ContentType} → {idea.Format})</em>
                  <br />
                  <span className="muted">{idea.Description}</span>
                  {idea.evidence && (
                    <span className="muted">
                      {" "}
                      — evidence at {idea.evidence.at}: “{idea.evidence.quote}” (confidence {idea.confidence})
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </section>
  );
}
