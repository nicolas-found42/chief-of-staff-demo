import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RunDetailResponse, WorkflowEvent } from "@chief-of-staff/contracts";
import { useParams } from "react-router-dom";
import type { AppClient } from "../api/client";
import { StatusPill } from "../components/StatusPill";
import { MarkdownPreview } from "../components/MarkdownPreview";

const BRANCH_LABELS: Record<string, string> = {
  ou028y_xg63bi: "Email",
  ou028y_vd3vc1: "Business plan",
  ou028y_wtnzhv: "Other",
};

const MAIN_STEP_ORDER = ["trigger", "eitxht", "yk5itn", "aase0r"];

export function RunDetailPage({ client }: { client: AppClient }) {
  const { runId = "" } = useParams<{ runId: string }>();
  const [detail, setDetail] = useState<RunDetailResponse | null>(null);
  const [error, setError] = useState("");
  const [events, setEvents] = useState<WorkflowEvent[]>([]);
  const [preview, setPreview] = useState<{ title: string; content: string } | null>(null);
  const [previewKind, setPreviewKind] = useState<"text" | "markdown">("text");
  const lastSequence = useRef(0);

  const refresh = useCallback(async () => {
    try {
      const value = await client.getRun(runId);
      setDetail(value);
      setError("");
      return value;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    }
  }, [client, runId]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    let cancelled = false;
    const run = async (): Promise<void> => {
      try {
        await client.streamEvents(runId, lastSequence.current, (event) => {
          if (cancelled) {
            return;
          }
          lastSequence.current = Math.max(lastSequence.current, event.sequence);
          setEvents((existing) => [...existing.slice(-499), event]);
        });
      } catch {
        // Stream errors are surfaced by the polling refresh.
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [client, runId]);
  const manifest = detail?.manifest;
  const groupedSteps = useMemo(() => {
    if (!manifest) {
      return { main: [], branches: new Map<string, []>() };
    }
    const main = manifest.steps.filter(
      (step) => MAIN_STEP_ORDER.includes(step.stepId) && step.taskIndex === null
    );
    const branches = new Map<string, NonNullable<typeof manifest>["steps"]>();
    for (const step of manifest.steps) {
      if (step.taskIndex !== null) {
        const key = String(step.taskIndex);
        const list = branches.get(key) ?? [];
        list.push(step);
        branches.set(key, list);
      }
    }
    return { main, branches };
  }, [manifest]);

  const openPreview = async (artifactId: string, type: string, title: string): Promise<void> => {
    try {
      const content = await client.getArtifact(artifactId);
      setPreview({ title, content });
      setPreviewKind(type === "gmail-draft" || type === "plan-document" || type === "notification" ? "markdown" : "text");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  if (error && !manifest) {
    return (
      <section className="page">
        <h1>Run</h1>
        <p className="bad">{error}</p>
      </section>
    );
  }
  if (!manifest) {
    return (
      <section className="page">
        <h1>Run</h1>
        <p className="muted">Loading…</p>
      </section>
    );
  }

  return (
    <section className="page" data-testid="run-detail" aria-labelledby="run-detail-heading">
      <h1 id="run-detail-heading">
        Run <code>{manifest.runId}</code>
      </h1>
      <p className="status-line">
        <StatusPill status={manifest.status} /> · {manifest.source.filename} ·{" "}
        {manifest.llm.mode} · {manifest.llm.model}
      </p>
      {manifest.error && (
        <div className="banner banner-error">
          {manifest.error.code}: {manifest.error.message}
        </div>
      )}
      {manifest.warnings.length > 0 && (
        <div className="banner banner-warn">
          Warnings:{" "}
          {manifest.warnings.map((warning) => `${warning.code}: ${warning.message}`).join(" · ")}
        </div>
      )}

      <h2>Tasks</h2>
      <table>
        <thead>
          <tr>
            <th scope="col">Task</th>
            <th scope="col">Type</th>
            <th scope="col">Branch</th>
            <th scope="col">Deadline</th>
          </tr>
        </thead>
        <tbody>
          {manifest.tasks.map((task) => (
            <tr key={task.index} data-testid="task-branch">
              <td>Task {task.index}</td>
              <td>{task.name}</td>
              <td>{BRANCH_LABELS[task.branch] ?? task.branch}</td>
              <td>{task.deadline ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Steps</h2>
      <table>
        <thead>
          <tr>
            <th scope="col">Step</th>
            <th scope="col">Task</th>
            <th scope="col">Status</th>
            <th scope="col">Duration</th>
            <th scope="col">Retries</th>
            <th scope="col">Detail</th>
          </tr>
        </thead>
        <tbody>
          {groupedSteps.main.map((step) => (
            <tr key={`${step.stepId}-${step.taskIndex ?? "main"}`} data-testid="step-row">
              <td>{step.stepId}</td>
              <td>—</td>
              <td>{step.status}</td>
              <td>{step.durationMs} ms</td>
              <td>{step.retryCount}</td>
              <td>{step.error ? `${step.error.code}: ${step.error.message}` : ""}</td>
            </tr>
          ))}
          {[...groupedSteps.branches.entries()].sort(([a], [b]) => Number(a) - Number(b)).map(([taskIndex, steps]) =>
            steps.map((step) => (
              <tr key={`${step.stepId}-${step.taskIndex ?? taskIndex}`} data-testid="step-row">
                <td>{step.stepId}</td>
                <td>{taskIndex}</td>
                <td>{step.status}</td>
                <td>{step.durationMs} ms</td>
                <td>{step.retryCount}</td>
                <td>{step.error ? `${step.error.code}: ${step.error.message}` : ""}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>

      <h2>Artifacts</h2>
      <ul className="artifact-list">
        {detail?.artifacts.map((artifact) => (
          <li key={artifact.artifactId}>
            <button
              type="button"
              data-testid="artifact-link"
              className="link-button"
              onClick={() =>
                void openPreview(artifact.artifactId, artifact.type, `${artifact.type} (${artifact.taskIndex ?? "run"})`)
              }
            >
              {artifact.type === "gmail-draft" ? "Draft" : artifact.type} · {artifact.artifactId}
            </button>
          </li>
        ))}
      </ul>

      {preview && (
        <div className="card">
          <h3>{preview.title}</h3>
          {previewKind === "markdown" ? (
            <MarkdownPreview source={preview.content} />
          ) : (
            <pre className="artifact-pre">{preview.content}</pre>
          )}
        </div>
      )}

      <h2>Events</h2>
      <div className="events-log" aria-live="polite">
        {events.map((event, index) => (
          <div key={`${event.sequence}-${index}`} className="event-row">
            <span className="muted">{event.sequence}</span> {event.type}
            {event.stepId ? ` · ${event.stepId}` : ""}
            {event.taskIndex !== null && event.taskIndex !== undefined ? ` · task ${event.taskIndex}` : ""}
            {event.error ? ` · ${event.error.code}` : ""}
          </div>
        ))}
      </div>
    </section>
  );
}
