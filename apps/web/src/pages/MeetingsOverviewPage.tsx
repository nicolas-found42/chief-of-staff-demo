import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type {
  DailyBriefingState,
  MeetingDebriefDetail,
  MeetingIndex,
  WeeklyBriefingState,
} from "@chief-of-staff-demo/shared";
import { api, errorMessage, onboardingApi } from "../client";
import { selectHomeActionItems, type HomeActionItem } from "../homeActionItems";
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
  const [index, setIndex] = useState<MeetingIndex | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [briefing, setBriefing] = useState<DailyBriefingState | null>(null);
  const [briefingBusy, setBriefingBusy] = useState(false);
  const [weekly, setWeekly] = useState<WeeklyBriefingState | null>(null);
  const [weeklyBusy, setWeeklyBusy] = useState(false);
  const [actionItems, setActionItems] = useState<HomeActionItem[] | null>(null);
  const [actionItemsError, setActionItemsError] = useState<string | null>(null);

  /**
   * Home action-item rollup (issue #159): the owner's or owner-unresolved
   * open non-dismissed items across Debriefs, reviewed or not, read through
   * the Debrief index plus one detail per Run. A single Run's failure never
   * hides the rest; an owner lookup failure lists unresolved items only.
   */
  const loadActionItems = useCallback(async () => {
    try {
      const [debriefIndex, owner] = await Promise.all([
        api.meetingDebriefIndex(),
        onboardingApi.owner().catch(() => ({ proposal: null, confirmed: null })),
      ]);
      const settled = await Promise.allSettled(
        debriefIndex.entries.map((entry) => api.meetingDebriefDetail(entry.runId)),
      );
      const details = settled.flatMap((result): MeetingDebriefDetail[] =>
        result.status === "fulfilled" ? [result.value] : [],
      );
      setActionItems(selectHomeActionItems(details, owner.confirmed?.profileId ?? null));
      setActionItemsError(null);
    } catch (err) {
      setActionItemsError(errorMessage(err));
    }
  }, []);

  const loadBriefing = useCallback(async (retry: boolean) => {
    setBriefingBusy(true);
    try {
      setBriefing(await (retry ? api.retryDailyBriefing() : api.dailyBriefing()));
    } catch (err) {
      setBriefing({ briefing: null, error: errorMessage(err), stale: false });
    } finally {
      setBriefingBusy(false);
    }
  }, []);

  const loadWeekly = useCallback(async (retry: boolean) => {
    setWeeklyBusy(true);
    try {
      setWeekly(await (retry ? api.retryWeeklyBriefing() : api.weeklyBriefing()));
    } catch (err) {
      setWeekly({ briefing: null, error: errorMessage(err), stale: false });
    } finally {
      setWeeklyBusy(false);
    }
  }, []);

  const refresh = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setIndex(await fetchMeetings());
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    void loadBriefing(false);
    void loadWeekly(false);
    void loadActionItems();
  }, [refresh, loadBriefing, loadWeekly, loadActionItems]);

  const meetings = index?.meetings ?? null;
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

      {index?.historyBeginsAt ? (
        <p className="muted">
          Meeting history begins{" "}
          <time dateTime={index.historyBeginsAt}>
            {new Date(index.historyBeginsAt).toLocaleDateString()}
          </time>
          .
        </p>
      ) : null}

      {error ? (
        <div className="banner banner-error" role="alert">
          {error}
        </div>
      ) : null}

      <div className="field-row">
        <button
          type="button"
          className="action-button"
          onClick={() => {
            void refresh();
            void loadBriefing(false);
            void loadWeekly(false);
            void loadActionItems();
          }}
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

      <section aria-labelledby="overview-briefing-heading">
        <h2 id="overview-briefing-heading">Daily briefing</h2>
        {!briefing ? (
          <p className="muted" role="status">
            Loading briefing…
          </p>
        ) : briefing.error ? (
          <div>
            <div className="banner banner-error" role="alert">
              {briefing.error}
            </div>
            <div className="field-row">
              <button
                type="button"
                className="action-button"
                onClick={() => void loadBriefing(true)}
                aria-disabled={briefingBusy}
              >
                {briefingBusy ? "Retrying…" : "Retry briefing"}
              </button>
            </div>
          </div>
        ) : briefing.briefing ? (
          <div>
            <p className="muted">{briefing.briefing.summary}</p>
            {briefing.stale ? (
              <p className="muted" role="status">
                Being updated — showing the previous briefing.
              </p>
            ) : null}
            <ul className="card-list">
              {briefing.briefing.meetings.map((entry) => (
                <li key={entry.meetingId} className="card">
                  <h3>
                    <Link to={`/meetings/${entry.meetingId}`}>{entry.title}</Link>
                  </h3>
                  <p>
                    <span className="muted">Starts:</span>{" "}
                    <time dateTime={entry.startAt}>{new Date(entry.startAt).toLocaleString()}</time>
                    {" · "}
                    <span className="muted">
                      {entry.briefStatus === "ready"
                        ? "Brief ready"
                        : entry.briefStatus === "pending"
                          ? "Brief preparing"
                          : "No brief"}
                    </span>
                  </p>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      <section aria-labelledby="overview-weekly-heading">
        <h2 id="overview-weekly-heading">Weekly briefing</h2>
        {!weekly ? (
          <p className="muted" role="status">
            Loading weekly briefing…
          </p>
        ) : weekly.error ? (
          <div>
            <div className="banner banner-error" role="alert">
              {weekly.error}
            </div>
            <div className="field-row">
              <button
                type="button"
                className="action-button"
                onClick={() => void loadWeekly(true)}
                aria-disabled={weeklyBusy}
              >
                {weeklyBusy ? "Retrying…" : "Retry weekly briefing"}
              </button>
            </div>
          </div>
        ) : weekly.briefing ? (
          <div>
            <p className="muted">{weekly.briefing.ranking}</p>
            {weekly.stale ? (
              <p className="muted" role="status">
                Being updated — showing the previous briefing.
              </p>
            ) : null}
            <ul className="card-list">
              {weekly.briefing.meetings.map((entry) => (
                <li key={entry.meetingId} className="card">
                  <h3>
                    <Link to={`/meetings/${entry.meetingId}`}>{entry.title}</Link>
                  </h3>
                  <p>
                    <span className="muted">Starts:</span>{" "}
                    <time dateTime={entry.startAt}>{new Date(entry.startAt).toLocaleString()}</time>
                    {" · "}
                    <span className="muted">
                      {entry.briefStatus === "ready"
                        ? "Brief ready"
                        : entry.briefStatus === "pending"
                          ? "Brief preparing"
                          : "No brief"}
                    </span>
                  </p>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      <section aria-labelledby="overview-action-items-heading">
        <h2 id="overview-action-items-heading">Action items</h2>
        {actionItems === null ? (
          actionItemsError ? (
            <div className="banner banner-error" role="alert">
              {actionItemsError}
            </div>
          ) : (
            <p className="muted" role="status">
              Loading action items…
            </p>
          )
        ) : actionItems.length === 0 ? (
          <p className="muted">No open action items.</p>
        ) : (
          <ul className="card-list">
            {actionItems.map((item) => (
              <li key={`${item.runId}:${item.index}`} className="card">
                <h3>
                  {item.meetingId ? (
                    <Link to={`/meetings/${item.meetingId}`}>{item.title}</Link>
                  ) : (
                    <Link to={`/meeting-debrief/${encodeURIComponent(item.runId)}`}>
                      {item.title}
                    </Link>
                  )}
                </h3>
                <p>
                  <span className="muted">Owner:</span> {item.owner ?? "unassigned"}
                  {item.dueDate ? (
                    <>
                      {" · "}
                      <span className="muted">Due {item.dueDate}</span>
                    </>
                  ) : null}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

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
