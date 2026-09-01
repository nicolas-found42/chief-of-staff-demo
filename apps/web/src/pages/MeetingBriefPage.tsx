import { useMemo } from "react";
import { Link, useParams } from "react-router-dom";
import type { MeetingBriefIndexEntry } from "@chief-of-staff-demo/shared";
import { api } from "../client";
import { useMeetingIndex } from "../useMeetingIndex";
import { usePageFocus } from "../usePageFocus";
import { useTitle } from "../useTitle";
import { deliveryPresentation } from "../modules/meeting-brief/deliveryStatus";

/** Stable fetcher: the Brief journey reads the module's Cross-Run index. */
const fetchIndex = () => api.meetingBriefIndex();

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
    list.sort((a, b) => {
      if (a.supersedes === b.runId) return -1;
      if (b.supersedes === a.runId) return 1;
      return Date.parse(b.createdAt) - Date.parse(a.createdAt);
    });
    groups.set(key, list);
  }
  return groups;
}

function DeliveryBadge({ delivery }: { delivery: MeetingBriefIndexEntry["delivery"] }) {
  if (!delivery) return <span className="muted">No delivery</span>;
  const presentation = deliveryPresentation(delivery.status);
  return (
    <span className={`status-badge ${presentation.className}`} role="status">
      {presentation.label}
    </span>
  );
}

export function MeetingBriefPage() {
  const { occurrenceKey } = useParams();
  const headingRef = usePageFocus<HTMLHeadingElement>();
  useTitle("Meeting Brief");
  const { index, error, busy, refresh, prepareNow } = useMeetingIndex(fetchIndex);

  const groups = useMemo(() => {
    if (!index) return new Map<string, MeetingBriefIndexEntry[]>();
    return groupByOccurrence(index.briefs);
  }, [index]);
  const visibleGroups = useMemo(
    () => (occurrenceKey ? new Map([...groups].filter(([key]) => key === occurrenceKey)) : groups),
    [groups, occurrenceKey],
  );

  const currentByOccurrence = useMemo(() => {
    const map = new Map<string, MeetingBriefIndexEntry>();
    const cancelled = new Set(index?.cancellations.map((item) => item.occurrenceKey) ?? []);
    for (const [key, list] of visibleGroups) {
      if (cancelled.has(key)) continue;
      const latestRevision = list[0];
      if (latestRevision) map.set(key, latestRevision);
    }
    return map;
  }, [visibleGroups, index]);

  if (!index) {
    return (
      <div className="page">
        <h1 ref={headingRef} tabIndex={-1}>
          Meeting Brief
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

  const upcoming = occurrenceKey
    ? index.upcoming.filter((item) => item.occurrenceKey === occurrenceKey)
    : index.upcoming;
  const briefs = occurrenceKey
    ? index.briefs.filter((entry) => entry.occurrenceKey === occurrenceKey)
    : index.briefs;

  return (
    <div className="page">
      <h1 ref={headingRef} tabIndex={-1}>
        Meeting Brief
      </h1>
      {occurrenceKey ? (
        <p>
          <Link to="/meetings">← Meeting Wizard overview</Link> · occurrence{" "}
          <code>{occurrenceKey}</code>
        </p>
      ) : null}
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
                  {entry.delivery && deliveryPresentation(entry.delivery.status).explanation ? (
                    <p className="muted">
                      {deliveryPresentation(entry.delivery.status).explanation}
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

      <section aria-labelledby="cancellation-heading">
        <h2 id="cancellation-heading">Cancelled meetings</h2>
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
                <p className="muted">
                  Completed Runs remain in revision history, but this occurrence is no longer a
                  current brief.
                </p>
              </li>
            ))}
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
                    {entry.delivery && deliveryPresentation(entry.delivery.status).explanation ? (
                      <p className="muted">
                        {deliveryPresentation(entry.delivery.status).explanation}
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
