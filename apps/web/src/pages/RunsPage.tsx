import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { RunSummary } from "@transcript-tasks/shared";
import { SourceBadge, StatusPill, formatTime } from "../components/StatusPill";
import { api, errorMessage } from "../client";
import { useTitle } from "../useTitle";

const TERMINAL = new Set(["done", "skipped", "failed"]);

export function RunsPage() {
  useTitle("Runs");
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

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
    const timer = setInterval(refresh, 3000);
    return () => clearInterval(timer);
  }, [refresh]);

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

  // Recomputed on every 3s poll, but the string only changes when the counts
  // do, so the live region stays quiet while nothing is happening.
  const listStatus =
    runs === null
      ? "Loading runs…"
      : `${runs.length} run${runs.length === 1 ? "" : "s"}, ` +
        `${runs.filter((run) => !TERMINAL.has(run.status)).length} in progress`;

  return (
    <div className="page">
      <h1>Runs</h1>

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
        {uploading ? (
          <p>Uploading…</p>
        ) : (
          <p>
            <strong>Drop transcripts here</strong> or{" "}
            <button
              type="button"
              className="linklike"
              onClick={(event) => {
                // The zone's own handler would otherwise open the picker twice.
                event.stopPropagation();
                inputRef.current?.click();
              }}
            >
              choose files
            </button>
          </p>
        )}
        {/* Outside the branch above: the file input references this id
            permanently, so removing it mid-upload would leave the reference
            dangling (WCAG 4.1.2). */}
        <p className="muted" id="upload-formats">
          .txt · .md · .json (Fireflies export) · .pdf · .docx — up to 10 MB each
        </p>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".txt,.md,.json,.pdf,.docx"
          hidden
          aria-label="Choose transcript files"
          aria-describedby="upload-formats"
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
        {uploading ? "Uploading transcripts…" : listStatus}
      </p>

      <div className="table-scroll">
        <table data-testid="runs-table">
          <caption className="visually-hidden">
            Transcript runs, newest first. Open a run from the link in its Created column.
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
            {(runs ?? []).map((run) => (
              <tr
                key={run.id}
                data-testid="run-row"
                data-run-id={run.id}
                className="run-row"
                onClick={() => navigate(`/runs/${run.id}`)}
              >
                <td>
                  {/* No aria-label: the row already supplies the filename in
                      its own cell, and repeating it here made screen readers
                      announce the name twice per row. Link purpose comes from
                      the row context instead (2.4.4), which is what the table
                      caption points at. */}
                  <Link
                    to={`/runs/${run.id}`}
                    className="run-link"
                    onClick={(event) => event.stopPropagation()}
                  >
                    {formatTime(run.createdAt)}
                  </Link>
                </td>
                <td>
                  <SourceBadge source={run.source} />
                </td>
                <td className="run-file-name">{run.fileName}</td>
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
      {runs !== null && runs.length === 0 && (
        <p className="muted">No runs yet — drop a transcript to get started.</p>
      )}
    </div>
  );
}
