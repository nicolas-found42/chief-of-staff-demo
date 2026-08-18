import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { RunSummary } from "@transcript-tasks/shared";
import { SourceBadge, StatusPill, formatTime } from "../components/StatusPill";
import { api, errorMessage } from "../client";

const TERMINAL = new Set(["done", "skipped", "failed"]);

export function RunsPage() {
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

  return (
    <div className="page">
      <h1>Runs</h1>

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
          <>
            <p>
              <strong>Drop transcripts here</strong> or click to choose files
            </p>
            <p className="muted">
              .txt · .md · .json (Fireflies export) · .pdf · .docx — up to 10 MB each
            </p>
          </>
        )}
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".txt,.md,.json,.pdf,.docx"
          hidden
          onChange={(event) => {
            void upload(Array.from(event.target.files ?? []));
            event.target.value = "";
          }}
        />
      </div>

      {error && <div className="banner banner-error">{error}</div>}

      <table data-testid="runs-table">
        <thead>
          <tr>
            <th>Created</th>
            <th>Source</th>
            <th>File</th>
            <th>Status</th>
            <th>Tasks</th>
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
              <td>{formatTime(run.createdAt)}</td>
              <td>
                <SourceBadge source={run.source} />
              </td>
              <td className="run-file-name">{run.fileName}</td>
              <td>
                <StatusPill status={run.status} />
                {!TERMINAL.has(run.status) && <span className="muted"> …</span>}
              </td>
              <td>{run.taskCount ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {runs !== null && runs.length === 0 && (
        <p className="muted">No runs yet — drop a transcript to get started.</p>
      )}
    </div>
  );
}
