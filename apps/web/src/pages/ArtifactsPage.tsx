import { useCallback, useEffect, useState } from "react";
import type { ArtifactType } from "@chief-of-staff/contracts";
import type { AppClient } from "../api/client";
import { MarkdownPreview } from "../components/MarkdownPreview";

type FilterKey = "all" | "gmail-draft" | "plan-document" | "task" | "notification" | "tracking-csv";

interface ArtifactEntry {
  artifactId: string;
  type: ArtifactType;
  runId: string;
  taskIndex: number | null;
  stepId: string;
}

const FILTERS: Array<{ key: FilterKey; label: string }> = [
  { key: "all", label: "All" },
  { key: "gmail-draft", label: "Drafts" },
  { key: "plan-document", label: "Plans" },
  { key: "task", label: "Tasks" },
  { key: "notification", label: "Notifications" },
  { key: "tracking-csv", label: "Tracking" },
];

export function ArtifactsPage({ client }: { client: AppClient }) {
  const [entries, setEntries] = useState<ArtifactEntry[]>([]);
  const [filter, setFilter] = useState<FilterKey>("all");
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<{ title: string; content: string; markdown: boolean } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const page = await client.listRuns();
      const collected: ArtifactEntry[] = [];
      for (const run of page.runs) {
        try {
          const detail = await client.getRun(run.runId);
          for (const artifact of detail.artifacts) {
            collected.push({
              artifactId: artifact.artifactId,
              type: artifact.type,
              runId: run.runId,
              taskIndex: artifact.taskIndex,
              stepId: artifact.stepId,
            });
          }
        } catch {
          // Skip runs whose details are unavailable.
        }
      }
      setEntries(collected);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const visible = entries.filter((entry) => filter === "all" || entry.type === filter);

  const openPreview = async (entry: ArtifactEntry): Promise<void> => {
    try {
      const content = await client.getArtifact(entry.artifactId);
      setPreview({
        title: `${entry.type} from ${entry.runId}`,
        content,
        markdown:
          entry.type === "gmail-draft" ||
          entry.type === "plan-document" ||
          entry.type === "notification",
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <section className="page" aria-labelledby="artifacts-heading">
      <h1 id="artifacts-heading">Artifacts</h1>
      {error && <p className="bad">{error}</p>}
      <div role="tablist" aria-label="Artifact type filters" className="tabs">
        {FILTERS.map((item) => (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={filter === item.key}
            className={filter === item.key ? "tab active" : "tab"}
            onClick={() => setFilter(item.key)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <table>
        <thead>
          <tr>
            <th scope="col">Type</th>
            <th scope="col">Run</th>
            <th scope="col">Task</th>
            <th scope="col">Step</th>
            <th scope="col">Preview</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((entry) => (
            <tr key={entry.artifactId}>
              <td>{entry.type}</td>
              <td>{entry.runId}</td>
              <td>{entry.taskIndex ?? "—"}</td>
              <td>{entry.stepId}</td>
              <td>
                <button
                  type="button"
                  className="link-button"
                  onClick={() => void openPreview(entry)}
                >
                  Preview
                </button>
              </td>
            </tr>
          ))}
          {visible.length === 0 && (
            <tr>
              <td colSpan={5} className="muted">
                No artifacts match this filter.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {preview && (
        <div className="card">
          <h2>{preview.title}</h2>
          {preview.markdown ? (
            <MarkdownPreview source={preview.content} />
          ) : (
            <pre className="artifact-pre">{preview.content}</pre>
          )}
        </div>
      )}
    </section>
  );
}
