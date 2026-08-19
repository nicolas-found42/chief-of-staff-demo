/* Run statuses, stages and sources are storage tokens. Nothing stops them
   reaching the screen verbatim except this file, so the mapping lives next to
   the components that render them (WCAG 3.1.3). An unknown token falls back to
   itself rather than disappearing — a diagnostic is better than a blank pill. */
const STATUS_LABELS: Record<string, string> = {
  pending: "Queued",
  extracting: "Extracting",
  "creating-outputs": "Creating outputs",
  done: "Done",
  skipped: "Skipped",
  failed: "Failed",
};

const STAGE_LABELS: Record<string, string> = {
  extract: "extraction",
  outputs: "output creation",
};

export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

export function stageLabel(stage: string): string {
  return STAGE_LABELS[stage] ?? stage;
}

export function StatusPill({ status }: { status: string }) {
  const cls =
    status === "done"
      ? "status-done"
      : status === "failed"
        ? "status-failed"
        : status === "skipped"
          ? "status-skipped"
          : "status-active";
  return <span className={`status-pill ${cls}`}>{statusLabel(status)}</span>;
}

export function SourceBadge({ source }: { source: string }) {
  return <span className={`source-badge source-${source}`}>{source}</span>;
}

export function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return date.toLocaleString();
}
