import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { MeetingBriefIndexEntry, MeetingBriefUpcoming } from "@chief-of-staff-demo/shared";
import { api, errorMessage } from "../client";
import { usePageFocus } from "../usePageFocus";
import { useTitle } from "../useTitle";

type IndexState = {
  upcoming: MeetingBriefUpcoming[];
  briefs: MeetingBriefIndexEntry[];
};

function groupByOccurrence(
  briefs: MeetingBriefIndexEntry[],
): Map<string, MeetingBriefIndexEntry[]> {
  const groups = new Map<string, MeetingBriefIndexEntry[]>();
  for (const entry of briefs) {
    const list = groups.get(entry.occurrenceKey) ?? [];
    list.push(entry);
    groups.set(entry.occurrenceKey, list);
  }
  for (const [key, list] of groups) {
    list.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    groups.set(key, list);
  }
  return groups;
}

function DeliveryBadge({ delivery }: { delivery: MeetingBriefIndexEntry["delivery"] }) {
  if (!delivery) return <span className="muted">No delivery</span>;
  const LABEL_BY_STATUS: Record<string, string> = {
    sent: "Sent",
    reconciled: "Sent (reconciled)",
    superseded: "Superseded",
    pending: "Pending",
    failed: "Failed",
    skipped: "Skipped",
  };
  const label = LABEL_BY_STATUS[delivery.status] ?? delivery.status;
  const cls =
    delivery.status === "sent" || delivery.status === "reconciled"
      ? "status-done"
      : delivery.status === "failed"
        ? "status-failed"
        : delivery.status === "superseded"
          ? "status-active"
          : "muted";
  return (
    <span className={`status-badge ${cls}`} role="status">
      {label}
    </span>
  );
}

export function MeetingBriefPage() {
  useTitle("Meeting Brief Generator");
  const headingRef = usePageFocus<HTMLHeadingElement>();
  const [index, setIndex] = useState<IndexState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const data = await api.meetingBriefIndex();
      const briefs = data.briefs as unknown as MeetingBriefIndexEntry[];
      const upcoming = data.upcoming as unknown as MeetingBriefUpcoming[];
      setIndex({ upcoming, briefs });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Poll while any brief is pending or blocked equivalent (pending delivery) or upcoming due soon.
  useEffect(() => {
    if (!index) return;
    const hasPending = index.briefs.some((b) => b.delivery?.status === "pending");
    if (!hasPending && index.upcoming.length === 0) return;
    const id = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(id);
  }, [index, refresh]);

  const groups = useMemo(() => {
    if (!index) return new Map<string, MeetingBriefIndexEntry[]>();
    return groupByOccurrence(index.briefs);
  }, [index]);

  const currentByOccurrence = useMemo(() => {
    const map = new Map<string, MeetingBriefIndexEntry>();
    for (const [key, list] of groups) {
      const latestDone = list.find((e) => e.status === "done") ?? list[0];
      if (latestDone) map.set(key, latestDone);
    }
    return map;
  }, [groups]);

  if (!index) {
    return (
      <div className="page">
        <h1 ref={headingRef} tabIndex={-1}>
          Meeting Brief Generator
        </h1>
        {error ? (
          <div className="banner banner-error" role="alert">
            {error}
          </div>
        ) : (
          <p className="muted" role="status">
            Loading meeting briefs…
          </p>
        )}
      </div>
    );
  }

  const upcoming = index.upcoming;
  const briefs = index.briefs;

  return (
    <div className="page">
      <h1 ref={headingRef} tabIndex={-1}>
        Meeting Brief Generator
      </h1>
      <p className="muted">
        Upcoming Eligible Meetings from Intake schedules; current briefs are latest per occurrence.
        History preserves revision chain and cancellation state. Briefs are derived from Runs — no
        live Gmail/HubSpot/Docs reads for history.
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
        <Link to="/runs?module=meeting-brief-generator" className="action-button">
          View all runs
        </Link>
      </div>

      <section aria-labelledby="upcoming-heading">
        <h2 id="upcoming-heading">Upcoming meetings</h2>
        {upcoming.length === 0 ? (
          <p className="muted">
            No upcoming Eligible Meetings — Intake holds no scheduled preparation.
          </p>
        ) : (
          <ul className="card-list">
            {upcoming.map((item) => (
              <li key={item.occurrenceKey} className="card">
                <h3>{item.summary}</h3>
                <p className="muted">
                  Event {item.eventId} · occurrence {item.occurrenceId} · version {item.version}
                </p>
                <p>
                  <span className="muted">Starts:</span>{" "}
                  <time dateTime={item.startAt}>{new Date(item.startAt).toLocaleString()}</time>
                </p>
                <p>
                  <span className="muted">Preparation due:</span>{" "}
                  <time dateTime={item.dueAt}>{new Date(item.dueAt).toLocaleString()}</time>
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="current-heading">
        <h2 id="current-heading">Current briefs</h2>
        {currentByOccurrence.size === 0 ? (
          <p className="muted">
            No Meeting Briefs yet — due meetings create Runs with 4 Stages: snapshot → enrich →
            compose → deliver.
          </p>
        ) : (
          <ul className="card-list">
            {Array.from(currentByOccurrence.entries()).map(([occurrenceKey, entry]) => {
              const brief = entry.meetingBrief;
              return (
                <li key={occurrenceKey} className="card">
                  <h3>
                    {brief ? brief.logistics.title : entry.eventId} ·{" "}
                    <Link to={`/runs/${entry.runId}`} className="step-link">
                      Run {entry.runId}
                    </Link>
                  </h3>
                  <p className="muted">
                    Occurrence {entry.occurrenceId} · version {entry.eventVersion} ·{" "}
                    <time dateTime={entry.createdAt}>
                      {new Date(entry.createdAt).toLocaleString()}
                    </time>{" "}
                    · status {entry.status}
                  </p>
                  {entry.supersedes ? (
                    <p className="muted">
                      Supersedes <Link to={`/runs/${entry.supersedes}`}>{entry.supersedes}</Link>
                    </p>
                  ) : null}
                  <p>
                    Delivery: <DeliveryBadge delivery={entry.delivery} />{" "}
                    {entry.delivery?.recipient ? `· to ${entry.delivery.recipient}` : ""}{" "}
                    {entry.delivery?.messageId ? `· ${entry.delivery.messageId}` : ""}{" "}
                    {entry.delivery?.deliveryId ? `· ${entry.delivery.deliveryId}` : ""}
                  </p>
                  {entry.delivery?.status === "superseded" ? (
                    <p className="muted">
                      This brief was superseded by a newer material Calendar change — only the
                      latest revision sends.
                    </p>
                  ) : null}
                  {entry.delivery?.status === "pending" ? (
                    <p className="muted">
                      Waiting for quiet period — will send after 5 minutes unless a newer change
                      arrives.
                    </p>
                  ) : null}
                  {brief ? (
                    <>
                      <p>{brief.summary}</p>
                      {brief.guests.length > 0 ? (
                        <div>
                          <h4>Guests</h4>
                          <ul>
                            {brief.guests.map((g) => (
                              <li key={g.email}>
                                {g.name ? `${g.name} — ${g.email}` : g.email}{" "}
                                {g.role ? `· ${g.role}` : ""}
                              </li>
                            ))}
                          </ul>
                        </div>
                      ) : null}
                      {brief.companies.length > 0 ? (
                        <div>
                          <h4>Companies</h4>
                          <ul>
                            {brief.companies.map((c) => (
                              <li key={c.name}>
                                {c.name} {c.domain ? `(${c.domain})` : ""}
                              </li>
                            ))}
                          </ul>
                        </div>
                      ) : null}
                      {brief.conversationStarters.length > 0 ? (
                        <div>
                          <h4>Conversation starters</h4>
                          <ol>
                            {brief.conversationStarters.map((s, idx) => (
                              <li key={idx}>{s}</li>
                            ))}
                          </ol>
                        </div>
                      ) : null}
                      {(brief.sourceReferences.length > 0 ||
                        brief.missingEvidence.length > 0 ||
                        brief.uncertainty.length > 0) && (
                        <div>
                          <h4>Sources & evidence</h4>
                          {brief.sourceReferences.length > 0 ? (
                            <ul>
                              {brief.sourceReferences.map((ref, idx) => (
                                <li key={idx}>
                                  <a href={ref} target="_blank" rel="noreferrer">
                                    {ref}
                                  </a>
                                </li>
                              ))}
                            </ul>
                          ) : null}
                          {brief.missingEvidence.length > 0 ? (
                            <div className="banner banner-warn" role="status">
                              <strong>Missing evidence:</strong> {brief.missingEvidence.join("; ")}
                            </div>
                          ) : null}
                          {brief.uncertainty.length > 0 ? (
                            <p className="muted">Uncertainty: {brief.uncertainty.join("; ")}</p>
                          ) : null}
                        </div>
                      )}
                      {/* Show at least one source link name for a11y */}
                    </>
                  ) : (
                    <p className="muted">No structured brief (run {entry.status})</p>
                  )}
                  <p>
                    <Link to={`/runs/${entry.runId}`} className="action-button">
                      Open Run detail
                    </Link>
                  </p>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section aria-labelledby="history-heading">
        <h2 id="history-heading">Revision history</h2>
        {briefs.length === 0 ? (
          <p className="muted">No historical briefs yet.</p>
        ) : (
          <ul className="card-list">
            {briefs
              .slice()
              .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
              .map((entry) => {
                const isCurrent =
                  currentByOccurrence.get(entry.occurrenceKey)?.runId === entry.runId;
                return (
                  <li key={entry.runId} className="card">
                    <p>
                      <Link to={`/runs/${entry.runId}`}>{entry.runId}</Link> · occurrence{" "}
                      {entry.occurrenceKey} · version {entry.eventVersion} ·{" "}
                      {new Date(entry.createdAt).toLocaleString()} ·{" "}
                      <span
                        className={`status-badge ${isCurrent ? "status-done" : "status-active"}`}
                      >
                        {isCurrent ? "Current" : "Superseded"}
                      </span>{" "}
                      <DeliveryBadge delivery={entry.delivery} />
                    </p>
                    {entry.supersedes ? (
                      <p className="muted">
                        Supersedes <Link to={`/runs/${entry.supersedes}`}>{entry.supersedes}</Link>
                      </p>
                    ) : null}
                    {entry.meetingBrief ? (
                      <p className="muted">{entry.meetingBrief.summary}</p>
                    ) : null}
                    <p>
                      Status: {entry.status} ·{" "}
                      <Link to={`/runs/${entry.runId}`}>
                        Run detail (Stages, attempts, files, timeline)
                      </Link>
                    </p>
                  </li>
                );
              })}
          </ul>
        )}
      </section>

      <section aria-labelledby="cancellation-heading">
        <h2 id="cancellation-heading">Cancellation & skipped</h2>
        <p className="muted">
          Cancellation removes future Intake candidates without creating a Runs history entry.
          Active Runs recheck Calendar before delivery and end skipped if cancelled; completed
          history remains but current state shows cancelled.
        </p>
        {briefs.filter((b) => b.status === "skipped").length === 0 ? (
          <p className="muted">
            No skipped briefs — cancellation state will appear here when Calendar reports cancelled.
          </p>
        ) : null}
      </section>

      <div className="card">
        <h3>How this page is built</h3>
        <p className="muted">
          Upcoming derived from Intake DurableClock schedules (Module-owned). Briefs derived from
          Runs on read — Cross-Run index invalidated only by Meeting Brief Generator writes. No live
          Gmail/HubSpot/Docs reads for history.
        </p>
        <p className="muted">Stages: snapshot | enrich | compose | deliver (fixed 4)</p>
      </div>
    </div>
  );
}
