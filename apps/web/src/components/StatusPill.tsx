import type { RunStatus } from "@chief-of-staff/contracts";

const LABELS: Record<RunStatus, string> = {
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  cancelled: "Cancelled",
  interrupted: "Interrupted",
};

export function StatusPill({ status }: { status: RunStatus }) {
  return (
    <span className={`status-pill status-${status}`} aria-label={`Status: ${LABELS[status]}`}>
      {LABELS[status]}
    </span>
  );
}
