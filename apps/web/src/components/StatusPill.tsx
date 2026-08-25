import { statusLabel } from "../display";

/* Run statuses, stages and sources are storage tokens; their display names live
   in ../display so every surface shares one vocabulary (spec D5–D7). This file
   is the pill itself: which state class a token earns, and the fallback that
   shows an unknown token instead of hiding it. */
export function StatusPill({
  status,
  connectionCaused,
}: {
  status: string;
  /** D6: a failure the Google connection caused is Needs attention (fix:
   *  reconnect), not Failed (fix: retry). The enum stays frozen. Absent and
   *  `undefined` both mean "not known to be the connection's fault". */
  connectionCaused?: boolean | undefined;
}) {
  const needsAttention = status === "failed" && connectionCaused === true;
  const cls = needsAttention
    ? "status-attention"
    : status === "blocked"
      ? "status-attention"
      : status === "done"
        ? "status-done"
        : status === "failed"
          ? "status-failed"
          : status === "skipped"
            ? "status-skipped"
            : "status-active";
  return (
    <span className={`status-badge ${cls}`}>
      {needsAttention ? "Needs attention" : statusLabel(status)}
    </span>
  );
}

export function IntakeBadge({ intake }: { intake: string }) {
  return <span className="status-badge status-source">{intake}</span>;
}
