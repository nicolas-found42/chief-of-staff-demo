import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type {
  DailyBriefingBriefStatus,
  DailyBriefingState,
  MeetingIndex,
  WeeklyBriefingState,
} from "@chief-of-staff-demo/shared";
import { api, errorMessage, onboardingApi } from "../client";
import { formatMeetingDate, formatMeetingTime } from "../display";
import { selectHomeActionItems, type HomeActionItem } from "../homeActionItems";
import { todaysMeetings } from "../todaysMeetings";
import { usePageFocus } from "../usePageFocus";
import { useTitle } from "../useTitle";

/** Past today, in the reader's own timezone. Dates are plain `YYYY-MM-DD`. */
function isOverdue(dueDate: string): boolean {
  const today = new Date();
  const local = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(
    today.getDate(),
  ).padStart(2, "0")}`;
  return dueDate < local;
}

/** Stable fetcher: the home reads the Meeting store (ADR-0050). */
const fetchMeetings = () => api.meetings();

/**
 * What a Brief's state means, and whether it is something to act on. `failed`
 * is its own state: a preparation that ran and failed reads as "No brief"
 * only if the page is willing to under-report its own failures.
 */
const BRIEF_STATUS: Record<DailyBriefingBriefStatus, { label: string; attention: boolean }> = {
  ready: { label: "Brief ready", attention: false },
  pending: { label: "Brief preparing", attention: false },
  failed: { label: "Brief failed", attention: true },
  missing: { label: "No brief", attention: false },
};

/** One meeting row. Both briefings render through it, so they cannot disagree. */
function MeetingRow({
  meetingId,
  title,
  startAt,
  briefStatus,
}: {
  meetingId: string;
  title: string;
  startAt: string;
  briefStatus: DailyBriefingBriefStatus;
}) {
  const status = BRIEF_STATUS[briefStatus];
  return (
    <li className="card">
      <h3>
        <Link to={`/meetings/${meetingId}`}>{title}</Link>
      </h3>
      <p>
        <time dateTime={startAt}>{formatMeetingTime(startAt)}</time>
        {" · "}
        {status.attention ? (
          <span className="status-badge status-attention">{status.label}</span>
        ) : (
          <span className="muted">{status.label}</span>
        )}
      </p>
    </li>
  );
}

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
   * Home action-item rollup (issue #159): the owner's open, undismissed items
   * across every Debrief, in one read. Ownership is settled by the resolved
   * Profile and, failing that, by the owner's own name — the Catalog resolves
   * few mentions, and without the name every unowned item read as theirs.
   */
  const loadActionItems = useCallback(async () => {
    try {
      const [rollup, owner] = await Promise.all([
        api.meetingDebriefActionItems(),
        onboardingApi.owner().catch(() => ({ proposal: null, confirmed: null })),
      ]);
      const profileId = owner.confirmed?.profileId ?? null;
      /* The owner's name, for items the Catalog left unresolved. A failed
         lookup only costs the name fallback, never the whole list. */
      const ownerName = profileId
        ? await api
            .personProfile(profileId)
            .then((profile) => profile.fullName)
            .catch(() => null)
        : null;
      setActionItems(selectHomeActionItems(rollup.items, profileId, ownerName));
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
  /* Meeting names for the action-item rollup, which carries a Meeting id and
     no title. The Meetings are already loaded for this page. */
  const meetingTitles = useMemo(
    () => new Map((meetings ?? []).map((meeting) => [meeting.id, meeting.title])),
    [meetings],
  );

  return (
    <div className="page">
      <h1 ref={headingRef} tabIndex={-1}>
        Meeting Wizard
      </h1>
      <p className="muted">
        Every meeting the workspace knows about — from your calendar, and from transcripts of
        meetings that were never on it. Each links to its own page, carrying its brief beforehand
        and its debrief afterwards.
      </p>

      {index?.historyBeginsAt ? (
        <p className="muted">
          Meeting history begins{" "}
          <time dateTime={index.historyBeginsAt}>{formatMeetingDate(index.historyBeginsAt)}</time>.
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
        <h2 id="overview-briefing-heading">Today</h2>
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
                <MeetingRow key={entry.meetingId} {...entry} />
              ))}
            </ul>
          </div>
        ) : (
          /* A briefing of null is a day with no Meetings, which is worth
             saying — silence here reads as a section that failed to load. */
          <p className="muted">No meetings today.</p>
        )}
      </section>

      <section aria-labelledby="overview-weekly-heading">
        <h2 id="overview-weekly-heading">This week</h2>
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
                <MeetingRow key={entry.meetingId} {...entry} />
              ))}
            </ul>
          </div>
        ) : (
          <p className="muted">No meetings this week.</p>
        )}
      </section>

      <section aria-labelledby="overview-action-items-heading">
        <h2 id="overview-action-items-heading">Your action items</h2>
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
                  {item.dueDate ? (
                    isOverdue(item.dueDate) ? (
                      <span className="status-badge status-attention">Overdue {item.dueDate}</span>
                    ) : (
                      <span className="muted">Due {item.dueDate}</span>
                    )
                  ) : (
                    <span className="muted">No due date</span>
                  )}
                  {/* Which meeting asked for it. "Polish slides together" with
                      no meeting beside it is a task nobody can place. */}
                  {item.meetingId && meetingTitles.get(item.meetingId) ? (
                    <span className="muted"> · from {meetingTitles.get(item.meetingId)}</span>
                  ) : null}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* The Meeting store's own view of today. The Daily briefing above is
          this list plus Brief state, so it is only worth drawing when that
          briefing could not be built — otherwise it is the same meetings a
          second time. */}
      {briefing?.error ? (
        <section aria-labelledby="overview-today-heading">
          <h2 id="overview-today-heading">Today&apos;s meetings</h2>
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
                    <time dateTime={meeting.startAt}>{formatMeetingTime(meeting.startAt)}</time>
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
      ) : null}
    </div>
  );
}
