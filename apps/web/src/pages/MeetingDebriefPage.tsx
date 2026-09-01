import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { MeetingDebriefIndex, MeetingDebriefIndexEntry } from "@chief-of-staff-demo/shared";
import { api, errorMessage } from "../client";
import { usePageFocus } from "../usePageFocus";
import { useTitle } from "../useTitle";

function RosterBadge({ entry }: { entry: MeetingDebriefIndexEntry }) {
  if (entry.rosterStatus === "prefilled") {
    return (
      <span className="status-badge status-ok" role="status">
        Roster prefilled from Calendar
      </span>
    );
  }
  return (
    <span className="status-badge status-attention" role="status">
      Roster confirmation required
    </span>
  );
}

function IdentityBadge({ entry }: { entry: MeetingDebriefIndexEntry }) {
  const parts: string[] = [];
  if (entry.identity.resolvedCount > 0) {
    parts.push(`${entry.identity.resolvedCount} resolved`);
  }
  if (entry.identity.unresolvedCount > 0) {
    parts.push(`${entry.identity.unresolvedCount} unresolved`);
  }
  if (entry.identity.organizationCount > 0) {
    parts.push(`${entry.identity.organizationCount} organizations`);
  }
  return <span className="muted">{parts.length > 0 ? parts.join(", ") : "No identity state"}</span>;
}

const REVIEW_STATE_LABELS: Record<string, string> = {
  awaiting_review: "Awaiting review",
  approved: "Approved",
  expired: "Expired",
};

function ReviewStateBadge({ entry }: { entry: MeetingDebriefIndexEntry }) {
  if (entry.reviewState === null) return <ReadinessBadge entry={entry} />;
  const label = REVIEW_STATE_LABELS[entry.reviewState] ?? entry.reviewState;
  const className =
    entry.reviewState === "approved"
      ? "status-badge status-ok"
      : entry.reviewState === "expired"
        ? "status-badge status-attention"
        : "status-badge";
  return (
    <span className={className} role="status">
      {label}
    </span>
  );
}

function ReadinessBadge({ entry }: { entry: MeetingDebriefIndexEntry }) {
  const label =
    entry.reviewReadiness === "ready"
      ? "Ready for review"
      : entry.reviewReadiness === "needs_roster"
        ? "Waiting for roster confirmation"
        : entry.status === "failed"
          ? "Extraction failed"
          : "Extraction pending";
  const className =
    entry.reviewReadiness === "ready"
      ? "status-badge status-ok"
      : entry.reviewReadiness === "needs_roster"
        ? "status-badge status-attention"
        : "status-badge";
  return (
    <span className={className} role="status">
      {label}
    </span>
  );
}

export function MeetingDebriefPage() {
  useTitle("Meeting Debrief");
  const headingRef = usePageFocus<HTMLHeadingElement>();
  const [index, setIndex] = useState<MeetingDebriefIndex | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setIndex(await api.meetingDebriefIndex());
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="page">
      <h1 ref={headingRef} tabIndex={-1}>
        Meeting Debrief
      </h1>
      <p className="muted">
        Every mined transcript gets a retrospective: decisions, action items, open questions, and
        coaching — extracted from the Transcript Catalog and waiting for your review. Approve it to
        lock it, regenerate any field, drop an action item, or let it expire after 30 days
        unreviewed. Nothing is written outward before your approval.
      </p>
      {error && (
        <p className="banner-error" role="alert">
          {error}
        </p>
      )}
      {busy && <p className="muted">Loading…</p>}
      {index && index.entries.length === 0 && (
        <p className="muted">
          No Meeting Debriefs yet. They appear here as the Transcript Catalog mines transcripts.
        </p>
      )}
      {index && index.entries.length > 0 && (
        <div className="table-scroll">
          <table>
            <caption className="visually-hidden">Meeting Debriefs</caption>
            <thead>
              <tr>
                <th scope="col">Meeting</th>
                <th scope="col">Date</th>
                <th scope="col">Calendar</th>
                <th scope="col">Roster</th>
                <th scope="col">Identity</th>
                <th scope="col">Recipients</th>
                <th scope="col">Review</th>
              </tr>
            </thead>
            <tbody>
              {index.entries.map((entry) => (
                <tr key={entry.runId}>
                  <td>
                    <Link to={`/meeting-debrief/${encodeURIComponent(entry.runId)}`}>
                      {entry.fileName ?? entry.transcriptId}
                    </Link>
                  </td>
                  <td>{entry.meetingDate ?? "—"}</td>
                  <td>{entry.linked ? "Linked" : "Not linked"}</td>
                  <td>
                    <RosterBadge entry={entry} />
                  </td>
                  <td>
                    <IdentityBadge entry={entry} />
                  </td>
                  <td>{entry.recipientCount}</td>
                  <td>
                    <ReviewStateBadge entry={entry} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
