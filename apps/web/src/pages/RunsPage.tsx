import { useCallback, useEffect, useRef, useState } from "react";
import type { RunSummary } from "@chief-of-staff/contracts";
import type { AppClient } from "../api/client";
import { StatusPill } from "../components/StatusPill";

const SUPPORTED = /\.(txt|md|pdf|docx)$/i;

export function RunsPage({ client }: { client: AppClient }) {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [error, setError] = useState("");
  const [uploadState, setUploadState] = useState<"idle" | "uploading" | "started" | "error">("idle");
  const [uploadError, setUploadError] = useState("");
  const [readinessBlockers, setReadinessBlockers] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const [actionError, setActionError] = useState("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const refresh = useCallback(async () => {
    try {
      const page = await client.listRuns();
      setRuns(page.runs);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [client]);

  useEffect(() => {
    void refresh();
    void client
      .getConfig()
      .then((config) => setReadinessBlockers(config.readiness.errors))
      .catch(() => setReadinessBlockers([]));
    const timer = window.setInterval(() => void refresh(), 4000);
    return () => window.clearInterval(timer);
  }, [client, refresh]);

  const uploadBlocked = readinessBlockers.length > 0;

  const upload = async (file: File): Promise<void> => {
    if (!SUPPORTED.test(file.name)) {
      setUploadState("error");
      setUploadError("Supported transcript formats: .txt, .md, .pdf, .docx");
      return;
    }
    setUploadState("uploading");
    setUploadError("");
    try {
      await client.uploadTranscript(file);
      setUploadState("started");
      await refresh();
    } catch (err) {
      setUploadState("error");
      setUploadError(err instanceof Error ? err.message : String(err));
    }
  };

  const act = async (runId: string, kind: "cancel" | "retry" | "rerun"): Promise<void> => {
    setActionError("");
    try {
      if (kind === "cancel") {
        await client.cancelRun(runId);
      } else if (kind === "retry") {
        await client.retryRun(runId);
      } else {
        await client.rerunRun(runId);
      }
      await refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <section className="page" aria-labelledby="runs-heading">
      <h1 id="runs-heading">Runs</h1>

      {uploadBlocked && (
        <div className="banner banner-warn" role="alert">
          Runs are blocked until the service is ready:
          <ul className="error-list">
            {readinessBlockers.map((blocker) => (
              <li key={blocker}>{blocker}</li>
            ))}
          </ul>
          Fix these in <a href="#/setup">Setup</a>.
        </div>
      )}

      <div
        className={`dropzone ${dragging ? "dragging" : ""} ${uploadBlocked ? "disabled" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          if (!uploadBlocked) {
            setDragging(true);
          }
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (uploadBlocked) {
            return;
          }
          const file = e.dataTransfer.files[0];
          if (file) {
            void upload(file);
          }
        }}
      >
        <p>
          Drop a transcript here, or{" "}
          <button
            type="button"
            className="link-button"
            disabled={uploadBlocked}
            onClick={() => fileInputRef.current?.click()}
          >
            choose a file
          </button>{" "}
          (.txt, .md, .pdf, .docx).
        </p>
        <input
          ref={fileInputRef}
          type="file"
          aria-label="Upload transcript"
          accept=".txt,.md,.pdf,.docx"
          style={{ display: "none" }}
          disabled={uploadBlocked}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) {
              void upload(file);
            }
            e.target.value = "";
          }}
        />
        <p data-testid="upload-status" aria-live="polite">
          {uploadState === "uploading" && <span className="muted">uploading…</span>}
          {uploadState === "started" && <span className="ok">started — watch the list below</span>}
          {uploadState === "error" && <span className="bad">{uploadError}</span>}
        </p>
      </div>

      {error && <p className="bad">{error}</p>}
      {actionError && <p className="bad">{actionError}</p>}

      <table>
        <thead>
          <tr>
            <th scope="col">Status</th>
            <th scope="col">Transcript</th>
            <th scope="col">Tasks</th>
            <th scope="col">Mode</th>
            <th scope="col">Created</th>
            <th scope="col">Error</th>
            <th scope="col">Actions</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr key={run.runId} data-testid="run-summary">
              <td>
                <StatusPill status={run.status} />
              </td>
              <td>
                <a href={`#/runs/${run.runId}`}>{run.sourceFilename}</a>
              </td>
              <td>
                {run.acceptedTaskCount}/{run.totalTaskCount}
              </td>
              <td>
                {run.mode} · {run.model}
              </td>
              <td>{new Date(run.createdAt).toLocaleString()}</td>
              <td>{run.error ? `${run.error.code}: ${run.error.message}` : ""}</td>
              <td>
                {run.status === "running" && (
                  <button type="button" onClick={() => void act(run.runId, "cancel")}>
                    Cancel
                  </button>
                )}
                {(run.status === "failed" || run.status === "cancelled" || run.status === "interrupted") && (
                  <button
                    type="button"
                    title="Resume the same run id, reusing verified outputs"
                    onClick={() => void act(run.runId, "retry")}
                  >
                    Retry (resume)
                  </button>
                )}
                <button
                  type="button"
                  title="Start a brand-new run from the same transcript"
                  onClick={() => void act(run.runId, "rerun")}
                >
                  Run again
                </button>
              </td>
            </tr>
          ))}
          {runs.length === 0 && (
            <tr>
              <td colSpan={7} className="muted">
                No runs yet. Upload a transcript to start.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );
}
