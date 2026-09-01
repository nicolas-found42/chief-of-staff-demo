import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { MeetingBriefIndexEntry } from "@chief-of-staff-demo/shared";
import { api, errorMessage } from "../client";
import { usePageFocus } from "../usePageFocus";
import { useTitle } from "../useTitle";
import { deliveryPresentation } from "../modules/meeting-brief/deliveryStatus";

type IndexState = {
  upcoming: {
    occurrenceKey: string;
    eventId: string;
    occurrenceId: string;
    version: string;
    summary: string;
    startAt: string;
    dueAt: string;
  }[];
  briefs: MeetingBriefIndexEntry[];
  cancellations: {
    occurrenceKey: string;
    summary: string;
    occurrenceId: string;
    version: string;
    cancelledAt: string;
  }[];
};

/**
 * Meeting Wizard Overview (spec #117): a read projection keyed by Calendar
 * occurrence. It shows upcoming eligible meetings, Brief schedule/readiness/
 * revisions/delivery, and cancellation state, and links into the sibling
 * journeys — it owns no combined meeting lifecycle record (ADR-0043).
 */
export function MeetingsOverviewPage() {
  useTitle("Meeting Wizard");
  const headingRef = usePageFocus<HTMLHeadingElement>();
  const [index, setIndex] = useState<IndexState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const data = await api.meetingsOverview();
      setIndex(data);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, []);

  const prepareNow = useCallback(async (occurrenceKey: string) => {
    setBusy(true);
    setError(null);
    try {
      await api.prepareMeetingBriefNow(occurrenceKey);
      const data = await api.meetingsOverview();
      setIndex(data);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Poll while a brief is preparing or delivery is pending.
  useEffect(() => {
    if (!index) return;
    const hasPending = index.briefs.some((b) => b.delivery?.status === "pending");
    if (!hasPending && index.upcoming.length === 0) return;
    const id = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(id);
  }, [index, refresh]);

  const currentByOccurrence = new Map<string, MeetingBriefIndexEntry>();
  const cancelled = new Set(index?.cancellations.map((item) => item.occurrenceKey) ?? []);
  for (const entry of index?.briefs ?? []) {
    if (cancelled.has(entry.occurrenceKey)) continue;
    const existing = currentByOccurrence.get(entry.occurrenceKey);
    if (!existing || Date.parse(entry.createdAt) > Date.parse(existing.createdAt)) {
      currentByOccurrence.set(entry.occurrenceKey, entry);
    }
  }

  return (
    <div className="page">
      <h1 ref={headingRef} tabIndex={-1}>
        Meeting Wizard
      </h1>
      <p className="muted">
        Calendar occurrences, Meeting Briefs, and their delivery in one overview. Prospective Brief
        and retrospective Debrief Runs stay separate workflows; this page links records, it does not
        merge their state.
      </p>

      {error ? (
        <div className="banner banner-error" role="alert">
          {error}
        </div>
      ) : null}

      <div className="field-row">
        <button
          type="button"
          className="action-button"
          onClick={() => void refresh()}
          aria-disabled={busy}
        >
          {busy ? "Refreshing…" : "Refresh"}
        </button>
        <Link to="/meetings/brief" className="action-button">
          Open the Brief journey
        </Link>
      </div>

      {!index ? (
        <p className="muted" role="status">
          Loading meeting overview…
        </p>
      ) : null}

      {index ? (
        <>
          <section aria-labelledby="overview-upcoming-heading">
            <h2 id="overview-upcoming-heading">Upcoming eligible meetings</h2>
            {index.upcoming.length === 0 ? (
              <p className="muted">
                No upcoming Eligible Meetings — timed, non-cancelled meetings with the owner and at
                least one other non-declined attendee schedule automatically.
              </p>
            ) : (
              <ul className="card-list">
                {index.upcoming.map((item) => (
                  <li key={item.occurrenceKey} className="card">
                    <h3>{item.summary}</h3>
                    <p>
                      <span className="muted">Starts:</span>{" "}
                      <time dateTime={item.startAt}>{new Date(item.startAt).toLocaleString()}</time>
                      {" · "}
                      <span className="muted">Preparation due:</span>{" "}
                      <time dateTime={item.dueAt}>{new Date(item.dueAt).toLocaleString()}</time>
                    </p>
                    <div className="field-row">
                      <button
                        type="button"
                        aria-disabled={busy}
                        onClick={() => {
                          if (busy) return;
                          void prepareNow(item.occurrenceKey);
                        }}
                      >
                        Prepare now
                      </button>
                      <Link to={`/meetings/brief/${encodeURIComponent(item.occurrenceKey)}`}>
                        Open Brief journey
                      </Link>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-labelledby="overview-briefs-heading">
            <h2 id="overview-briefs-heading">Brief readiness</h2>
            {currentByOccurrence.size === 0 ? (
              <p className="muted">No current Meeting Briefs.</p>
            ) : (
              <ul className="card-list">
                {[...currentByOccurrence.entries()].map(([occurrenceKey, entry]) => {
                  const presentation = entry.delivery
                    ? deliveryPresentation(entry.delivery.status)
                    : null;
                  return (
                    <li key={occurrenceKey} className="card">
                      <h3>
                        {entry.meetingBrief ? entry.meetingBrief.logistics.title : entry.eventId}
                      </h3>
                      <p>
                        <span className="muted">Revision:</span> version {entry.eventVersion} ·{" "}
                        <time dateTime={entry.createdAt}>
                          {new Date(entry.createdAt).toLocaleString()}
                        </time>{" "}
                        · Run status {entry.status}
                      </p>
                      <p>
                        <span className="muted">Delivery:</span>{" "}
                        {entry.delivery && presentation ? (
                          <>
                            <span
                              className={`status-badge ${presentation.className}`}
                              role="status"
                            >
                              {presentation.label}
                            </span>
                            {entry.delivery.recipient ? ` · to ${entry.delivery.recipient}` : ""}
                          </>
                        ) : (
                          <span className="muted">No delivery</span>
                        )}
                      </p>
                      <p>
                        <Link to={`/meetings/brief/${encodeURIComponent(occurrenceKey)}`}>
                          Open Brief journey
                        </Link>{" "}
                        · <Link to={`/runs/${entry.runId}`}>Run {entry.runId}</Link>
                      </p>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section aria-labelledby="overview-cancelled-heading">
            <h2 id="overview-cancelled-heading">Cancelled occurrences</h2>
            {index.cancellations.length === 0 ? (
              <p className="muted">No cancelled meeting occurrences.</p>
            ) : (
              <ul className="card-list">
                {index.cancellations.map((cancellation) => (
                  <li key={cancellation.occurrenceKey} className="card">
                    <h3>{cancellation.summary}</h3>
                    <p>
                      <span className="status-badge status-active">Cancelled</span> · occurrence{" "}
                      {cancellation.occurrenceId} · version {cancellation.version}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}
