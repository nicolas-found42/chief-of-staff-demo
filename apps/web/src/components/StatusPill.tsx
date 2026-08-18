export function StatusPill({ status }: { status: string }) {
  const cls =
    status === "done"
      ? "status-done"
      : status === "failed"
        ? "status-failed"
        : status === "skipped"
          ? "status-skipped"
          : "status-active";
  return <span className={`status-pill ${cls}`}>{status}</span>;
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
