import { ProposalMeetingNavigation } from "../components/ProposalMeetingNavigation";
import { useReadingPosition } from "../useReadingPosition";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { MeetingWorkspaceView, TaskOverview } from "@chief-of-staff-demo/shared";
import { meetingsApi, type MeetingsClient } from "../clients/meetings";
import { tasksApi, type TasksClient } from "../clients/tasks";
import { MeetingWizardTabs } from "../components/MeetingWizardTabs";
import { MeetingReadRow } from "../components/MeetingReadRow";
import { meetingDate } from "../meetingDisplay";
import { usePageFocus } from "../usePageFocus";
import { useTitle } from "../useTitle";
import "./meetingWizard.css";

export function MeetingsOverviewPage({
  client = meetingsApi,
  tasksClient = tasksApi,
}: {
  client?: MeetingsClient;
  tasksClient?: TasksClient;
}) {
  useTitle("Meeting Wizard");
  const headingRef = usePageFocus<HTMLHeadingElement>();
  const [view, setView] = useState<MeetingWorkspaceView | null>(null);
  useReadingPosition(view !== null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [work, setWork] = useState<TaskOverview | null>(null);
  const [workError, setWorkError] = useState<string | null>(null);
  const generation = useRef(0);
  const load = useCallback(async () => {
    const request = ++generation.current;
    setBusy(true);
    const [meetings, tasks] = await Promise.allSettled([
      client.workspace(),
      tasksClient.overview(),
    ]);
    if (request !== generation.current) return;
    if (meetings.status === "fulfilled") {
      setView(meetings.value);
      setError(null);
    } else
      setError("Meetings could not be refreshed. Any previously shown data may be out of date.");
    if (tasks.status === "fulfilled") {
      setWork(tasks.value);
      setWorkError(null);
    } else
      setWorkError("Task counts are unavailable. Any previously shown Tasks may be out of date.");
    setBusy(false);
  }, [client, tasksClient]);
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 3000);
    const focus = () => void load();
    window.addEventListener("focus", focus);
    const invalidate = () => {
      generation.current++;
    };
    return () => {
      invalidate();
      window.clearInterval(timer);
      window.removeEventListener("focus", focus);
    };
  }, [load]);
  const refresh = () => void load();
  const groups = [
    { id: "today", title: "Today", rows: view?.today, empty: "No meetings today." },
    {
      id: "recent",
      title: "Recent meetings",
      rows: view?.recent,
      empty: "No completed meetings recorded yet.",
    },
    {
      id: "upcoming",
      title: "Upcoming",
      rows: view?.upcoming,
      empty: "No meetings in the upcoming range.",
    },
  ];
  return (
    <div className="page">
      <header className="wizard-head">
        <h1 ref={headingRef} tabIndex={-1}>
          Meeting Wizard
        </h1>
        <MeetingWizardTabs />
        <p className="wizard-standfirst">
          Prepare for what’s next, revisit recent Meetings, and review proposed work.
        </p>
        <button type="button" className="action-button" disabled={busy} onClick={refresh}>
          {busy ? "Refreshing…" : "Refresh"}
        </button>
      </header>
      {error ? <p role="alert">{error}</p> : null}
      {view?.partial.map((message) => (
        <p role="status" key={message}>
          {message}
        </p>
      ))}
      {groups.map(({ id, title, rows, empty }, index) => (
        <section key={id} className="wizard-section" aria-labelledby={`wizard-${id}-heading`}>
          <div className="wizard-section-head">
            <span className="wizard-num" aria-hidden="true">
              0{index + 1}
            </span>
            <h2 id={`wizard-${id}-heading`}>{title}</h2>
            <span className="wizard-count">
              {rows ? `${rows.length} meeting${rows.length === 1 ? "" : "s"}` : "Count unavailable"}
            </span>
          </div>
          {id === "today" && rows ? (
            <p className="wizard-note">
              {rows.some((m) => m.brief.status === "unavailable")
                ? "Brief count unavailable"
                : `${rows.filter((m) => m.brief.status === "ready").length} Briefs ready`}{" "}
              ·{" "}
              {rows.some((m) => m.debrief.status === "unavailable")
                ? "Debrief count unavailable"
                : `${rows.filter((m) => m.debrief.status === "ready").length} Debriefs ready`}{" "}
              ·{" "}
              {rows.some(
                (m) => m.brief.status === "unavailable" || m.debrief.status === "unavailable",
              )
                ? "Failed-attempt count unavailable"
                : `${rows.filter((m) => m.brief.latestAttempt === "failed" || m.debrief.latestAttempt === "failed").length} meeting${rows.filter((m) => m.brief.latestAttempt === "failed" || m.debrief.latestAttempt === "failed").length === 1 ? "" : "s"} with a failed attempt`}
            </p>
          ) : null}
          {id === "recent" ? (
            <p className="wizard-note">
              The five most recently completed Meetings, across week boundaries.{" "}
              <Link to="/meetings/history">View meeting history</Link>
            </p>
          ) : null}
          {id === "upcoming" && view ? (
            <p className="wizard-note">
              {meetingDate(view.upcomingFrom)}–{meetingDate(view.upcomingTo)} ({view.timezone}).{" "}
              <Link to="/meetings/weekly">This week</Link> covers Sunday–Saturday, which may differ
              from this range.
            </p>
          ) : null}
          {!rows ? (
            <p role="status">{error ? "Meeting data unavailable." : "Loading meetings…"}</p>
          ) : rows.length ? (
            <ul className="wizard-ledger">
              {rows.map((meeting) => (
                <MeetingReadRow
                  key={meeting.id}
                  meeting={meeting}
                  timezone={view!.timezone}
                  refresh={refresh}
                  excerpt={id === "recent"}
                />
              ))}
            </ul>
          ) : (
            <p className="wizard-empty">{empty}</p>
          )}
        </section>
      ))}
      <section className="wizard-section" aria-labelledby="wizard-work-heading">
        <div className="wizard-section-head">
          <span className="wizard-num" aria-hidden="true">
            04
          </span>
          <h2 id="wizard-work-heading">Your work</h2>
        </div>
        <div id="awaiting-approval">
          <h3>Meetings awaiting approval</h3>
          <ProposalMeetingNavigation />
        </div>
        <h3>
          Tasks
          {work && !workError ? ` (${work.counts.open} open · ${work.counts.overdue} overdue)` : ""}
        </h3>
        {workError ? <p role="status">{workError}</p> : null}
        {work ? (
          <>
            {work.tasks.length ? (
              <ul>
                {work.tasks.map((task) => (
                  <li key={task.id}>
                    <Link to={`/tasks#task-${task.id}`}>{task.title}</Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p>No open Tasks.</p>
            )}
            <Link to="/tasks">View all Tasks</Link>
          </>
        ) : (
          <p role="status">Loading Tasks…</p>
        )}
      </section>
      {view?.historyBeginsAt ? (
        <p className="muted">
          Recorded meeting history begins {meetingDate(view.historyBeginsAt)}.{" "}
          <Link to="/meetings/history">Browse recorded history</Link>
        </p>
      ) : null}
    </div>
  );
}
