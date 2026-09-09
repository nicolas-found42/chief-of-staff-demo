import { meetingDate } from "../meetingDisplay";
import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { MeetingArtifact, MeetingReadRow as Row } from "@chief-of-staff-demo/shared";
import { runsApi } from "../clients/workspace";

export function MeetingArtifactStatus({
  artifact,
  kind,
  meetingId,
  refresh,
  linkReady = true,
}: {
  artifact: MeetingArtifact;
  kind: "brief" | "debrief";
  meetingId: string;
  refresh: () => void;
  linkReady?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const active = useRef(false);
  const [notice, setNotice] = useState<string | null>(null);
  const title = kind === "brief" ? "Brief" : "Debrief";
  const labels = {
    ready: `${title} ready`,
    queued: `${title} queued`,
    processing: `${title} processing`,
    failed: `${title} failed`,
    missing: `${title} not prepared`,
    "no-transcript": "No Transcript for Debrief",
    unavailable: `${title} status unavailable`,
  };
  async function retry() {
    if (active.current || !artifact.retryRunId) return;
    active.current = true;
    setBusy(true);
    setNotice(null);
    try {
      await runsApi.retry(artifact.retryRunId);
      setNotice(`${title} retry submitted.`);
      refresh();
    } catch {
      setNotice(`${title} retry failed. Check the workflow settings and try again.`);
    } finally {
      active.current = false;
      setBusy(false);
    }
  }
  return (
    <div className="meeting-artifact">
      {artifact.status === "ready" && linkReady ? (
        <Link to={`/meetings/${meetingId}?tab=${kind}`}>{labels.ready}</Link>
      ) : (
        <span>{labels[artifact.status]}</span>
      )}
      {artifact.status === "ready" && artifact.latestAttempt ? (
        <span> · Latest attempt {artifact.latestAttempt}</span>
      ) : null}
      {artifact.explanation ? <span className="muted"> {artifact.explanation}</span> : null}
      {artifact.retryRunId ? (
        <>
          <span className="muted">
            {kind === "brief" ? " Retrying may send the Brief to the connected owner." : " "}
          </span>{" "}
          <button type="button" disabled={busy} onClick={() => void retry()}>
            {busy ? "Retrying…" : `Retry ${kind}`}
          </button>
        </>
      ) : null}
      {artifact.remedy ? (
        <>
          {" "}
          <Link to={artifact.remedy}>Check workflow settings</Link>
        </>
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
    </div>
  );
}
export function MeetingReadRow({
  meeting,
  timezone,
  refresh,
  excerpt = false,
}: {
  meeting: Row;
  timezone: string;
  refresh: () => void;
  excerpt?: boolean;
}) {
  const participants = meeting.participants.map((p) => p.displayName || p.email);
  const time = meeting.dateOnly
    ? "Date only"
    : new Intl.DateTimeFormat(undefined, {
        hour: "numeric",
        minute: "2-digit",
        timeZone: timezone,
      }).format(new Date(meeting.startAt));
  return (
    <li className="wizard-line meeting-read-row">
      <div className="meeting-row-heading">
        <Link to={`/meetings/${meeting.id}`}>{meeting.title}</Link>
        <span>
          {meeting.cancelled
            ? "Cancelled"
            : meeting.group === "completed"
              ? "Completed"
              : meeting.group === "in-progress"
                ? "In progress"
                : "Upcoming"}
        </span>
      </div>
      <p className="muted">
        <time dateTime={meeting.startAt}>
          {meetingDate(meeting.localDate)} · {time}
        </time>{" "}
        · {participants.slice(0, 3).join(", ") || "Participants unavailable"}
        {participants.length > 3 ? ` +${participants.length - 3} more` : ""}
      </p>
      <MeetingArtifactStatus
        artifact={meeting.brief}
        kind="brief"
        meetingId={meeting.id}
        refresh={refresh}
      />
      <MeetingArtifactStatus
        artifact={meeting.debrief}
        kind="debrief"
        meetingId={meeting.id}
        refresh={refresh}
      />
      {excerpt && meeting.debrief.summary ? (
        <p className="meeting-excerpt">{meeting.debrief.summary}</p>
      ) : null}
      <span className="muted">
        {meeting.pendingCount === null
          ? "Pending Action Item count unavailable"
          : `${meeting.pendingCount} pending action items`}
      </span>
    </li>
  );
}
