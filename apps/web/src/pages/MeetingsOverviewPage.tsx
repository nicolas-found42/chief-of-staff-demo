import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { Meeting } from "@chief-of-staff-demo/shared";
import { api, errorMessage } from "../client";
import { todaysMeetings } from "../todaysMeetings";
import { usePageFocus } from "../usePageFocus";
import { useTitle } from "../useTitle";

/** Stable fetcher: the home reads the Meeting store (ADR-0050). */
const fetchMeetings = () => api.meetings();

/**
 * Meeting Wizard home (issue #151): reads the Workspace's Meetings rather
 * than projecting over Brief records, and lists today's Meetings in start
 * order, each linking to its page. The Brief and Debrief journeys stay
 * separate workflows (ADR-0043); their surfaces live at their own routes.
 */
export function MeetingsOverviewPage() {
  useTitle("Meeting Wizard");
  const headingRef = usePageFocus<HTMLHeadingElement>();
  const [meetings, setMeetings] = useState<Meeting[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setMeetings((await fetchMeetings()).meetings);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const todays = meetings ? todaysMeetings(meetings, new Date()) : null;

  return (
    <div className="page">
      <h1 ref={headingRef} tabIndex={-1}>
        Meeting Wizard
      </h1>
      <p className="muted">
        Today's Meetings, read from the Workspace's own record. Each Meeting links to its page; the
        Brief and Debrief journeys stay separate workflows.
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
        <Link to="/meeting-debrief" className="action-button">
          Open the Debrief journey
        </Link>
      </div>

      <section aria-labelledby="overview-today-heading">
        <h2 id="overview-today-heading">Today's meetings</h2>
        {!todays ? (
          <p className="muted" role="status">
            Loading meetings…
          </p>
        ) : todays.length === 0 ? (
          <p className="muted">No meetings today.</p>
        ) : (
          <ul className="card-list">
            {todays.map((meeting) => (
              <li key={meeting.id} className="card">
                <h3>
                  <Link to={`/meetings/${meeting.id}`}>{meeting.title}</Link>
                </h3>
                <p>
                  <span className="muted">Starts:</span>{" "}
                  <time dateTime={meeting.startAt}>
                    {new Date(meeting.startAt).toLocaleString()}
                  </time>
                  {meeting.cancelled ? (
                    <>
                      {" · "}
                      <span className="status-badge status-active">Cancelled</span>
                    </>
                  ) : null}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
