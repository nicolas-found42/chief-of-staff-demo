/**
 * PROTOTYPE — throwaway UI exploration, not production code.
 *
 * "Three design-system directions for the Shell's pages, switchable via
 * `?variant=`, on the existing `/meetings` route."
 *
 * The question is not "what should this page look like" but "what is the
 * system" — the app's pages beyond Home are default-browser plain, and the
 * link is the missing sixth primitive beside ADR-0015's five (raw blue anchors
 * are the most visible symptom). So each variant redefines the whole
 * vocabulary — link, row, chip, button, section header, empty state — and
 * draws that vocabulary on its own in a specimen strip above the page, so the
 * system can be judged rather than just the layout.
 *
 * A — Quiet Rail       Linear/Vercel lineage. Hairlines, rows, one accent.
 * B — Day Spine        Time-first. A vertical spine plus a sticky task dock.
 * C — Editorial Ledger Swiss/print. Type only: no card, pill or shadow.
 *
 * Read-only: `onRefresh` is the host page's, nothing else mutates.
 * Delete this file with the losing variants when one wins.
 */
import {
  AlertTriangle,
  ArrowRight,
  CalendarClock,
  CalendarDays,
  Check,
  CircleDot,
  Clock,
  FileText,
  Inbox,
  ListTodo,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { Link } from "react-router-dom";
import type {
  DailyBriefingBriefStatus,
  DailyBriefingState,
  MeetingIndex,
  WeeklyBriefingState,
} from "@chief-of-staff-demo/shared";
import { formatMeetingDate, formatMeetingTime } from "../display";
import type { HomeActionItem } from "../homeActionItems";

/** Everything the host page already fetched. Variants never fetch. */
export interface ProtoData {
  index: MeetingIndex | null;
  briefing: DailyBriefingState | null;
  weekly: WeeklyBriefingState | null;
  actionItems: HomeActionItem[] | null;
  actionItemsError: string | null;
  meetingTitles: Map<string, string>;
  busy: boolean;
  onRefresh: () => void;
}

type Tone = "ok" | "warn" | "bad" | "none";

const STATUS: Record<DailyBriefingBriefStatus, { label: string; tone: Tone }> = {
  ready: { label: "Brief ready", tone: "ok" },
  pending: { label: "Preparing", tone: "warn" },
  failed: { label: "Brief failed", tone: "bad" },
  missing: { label: "No brief", tone: "none" },
};

/** Clock time only. `formatMeetingTime` carries the weekday and date too,
    which is right in a row but too wide for the spine's gutter. */
function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** Weekday only, for the line under the clock time in the spine's gutter. */
function weekday(iso: string): string {
  return new Date(iso).toLocaleDateString([], { weekday: "short" });
}

/** "1 meeting" / "2 meetings" — direction C prints the count beside every
    section head, where a bare "1 meetings" is the first thing you notice. */
function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** Past today, in the reader's own timezone. Dates are plain `YYYY-MM-DD`. */
function isOverdue(dueDate: string): boolean {
  const now = new Date();
  const local = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
    now.getDate(),
  ).padStart(2, "0")}`;
  return dueDate < local;
}

/* ==========================================================================
   A — QUIET RAIL
   ========================================================================== */

function SpecA() {
  return (
    <div className="spec-strip">
      <span className="spec-label">System A</span>
      <a className="a-link" href="#spec">
        Row link
      </a>
      <a className="a-link-inline" href="#spec">
        inline link
      </a>
      <button type="button" className="a-btn a-btn-primary">
        <Sparkles size={14} /> Primary
      </button>
      <button type="button" className="a-btn">
        Quiet
      </button>
      <span className="a-chip a-chip-ok">
        <Check size={11} /> Ready
      </span>
      <span className="a-chip a-chip-warn">Preparing</span>
      <span className="a-chip a-chip-bad">Failed</span>
      <span className="a-chip">Neutral</span>
    </div>
  );
}

function RowA({
  to,
  title,
  meta,
  sub,
  icon,
}: {
  to: string;
  title: string;
  meta: React.ReactNode;
  sub?: string | undefined;
  icon: React.ReactNode;
}) {
  return (
    <li className="a-row">
      <span className="a-row-icon">{icon}</span>
      <span className="a-row-main">
        <Link className="a-link" to={to}>
          {title}
        </Link>
        {sub ? <span className="a-row-sub"> · {sub}</span> : null}
      </span>
      <span className="a-row-meta">
        {meta}
        <ArrowRight className="a-row-chev" size={13} />
      </span>
    </li>
  );
}

function ChipA({ tone, label }: { tone: Tone; label: string }) {
  const cls = tone === "none" ? "a-chip" : `a-chip a-chip-${tone}`;
  return <span className={cls}>{label}</span>;
}

export function VariantA({ data }: { data: ProtoData }) {
  const { briefing, weekly, actionItems, meetingTitles, index, busy, onRefresh } = data;
  return (
    <div className="mproto-a">
      <SpecA />
      <header className="a-head">
        <p className="a-title" aria-hidden="true">
          Meeting Wizard
        </p>
        <p>
          Every meeting the workspace knows about — from your calendar, and from transcripts of
          meetings that were never on it.
        </p>
        {index?.historyBeginsAt ? (
          <p>
            History begins{" "}
            <time dateTime={index.historyBeginsAt}>{formatMeetingDate(index.historyBeginsAt)}</time>
            .
          </p>
        ) : null}
        <div className="a-actions">
          <Link className="a-btn a-btn-primary" to="/meetings/brief">
            <FileText size={14} /> Brief journey
          </Link>
          <Link className="a-btn" to="/meeting-debrief">
            <ListTodo size={14} /> Debrief journey
          </Link>
          <button type="button" className="a-btn" onClick={onRefresh} aria-disabled={busy}>
            <RefreshCw size={14} /> {busy ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </header>

      <div className="a-railgrid">
        <div className="a-railgrid-label">
          <CalendarClock size={13} />
          <h2>Today</h2>
        </div>
        <div className="a-railgrid-body">
          {briefing?.error ? (
            <p className="proto-error">{briefing.error}</p>
          ) : briefing?.briefing ? (
            <>
              <p className="a-note">{briefing.briefing.summary}</p>
              <ul className="a-rows">
                {briefing.briefing.meetings.map((m) => {
                  const s = STATUS[m.briefStatus];
                  return (
                    <RowA
                      key={m.meetingId}
                      to={`/meetings/${m.meetingId}`}
                      title={m.title}
                      icon={<CircleDot size={13} />}
                      meta={
                        <>
                          <ChipA tone={s.tone} label={s.label} />
                          <span>{formatMeetingTime(m.startAt)}</span>
                        </>
                      }
                    />
                  );
                })}
              </ul>
            </>
          ) : (
            <p className="a-blank">No meetings today.</p>
          )}
        </div>

        <div className="a-railgrid-label">
          <CalendarDays size={13} />
          <h2>This week</h2>
        </div>
        <div className="a-railgrid-body">
          {weekly?.error ? (
            <p className="proto-error">{weekly.error}</p>
          ) : weekly?.briefing ? (
            <>
              <p className="a-note">{weekly.briefing.ranking}</p>
              <ul className="a-rows">
                {weekly.briefing.meetings.map((m) => {
                  const s = STATUS[m.briefStatus];
                  return (
                    <RowA
                      key={m.meetingId}
                      to={`/meetings/${m.meetingId}`}
                      title={m.title}
                      icon={<CircleDot size={13} />}
                      meta={
                        <>
                          <ChipA tone={s.tone} label={s.label} />
                          <span>{formatMeetingTime(m.startAt)}</span>
                        </>
                      }
                    />
                  );
                })}
              </ul>
            </>
          ) : (
            <p className="a-blank">No meetings this week.</p>
          )}
        </div>

        <div className="a-railgrid-label">
          <ListTodo size={13} />
          <h2>Actions</h2>
        </div>
        <div className="a-railgrid-body">
          {actionItems === null ? (
            <p className="a-blank">Loading action items…</p>
          ) : actionItems.length === 0 ? (
            <p className="a-blank">No open action items.</p>
          ) : (
            <ul className="a-rows">
              {actionItems.map((item) => (
                <RowA
                  key={`${item.runId}:${item.index}`}
                  to={
                    item.meetingId
                      ? `/meetings/${item.meetingId}`
                      : `/meeting-debrief/${encodeURIComponent(item.runId)}`
                  }
                  title={item.title}
                  icon={<Check size={13} />}
                  sub={
                    item.meetingId ? (meetingTitles.get(item.meetingId) ?? undefined) : undefined
                  }
                  meta={
                    item.dueDate ? (
                      isOverdue(item.dueDate) ? (
                        <ChipA tone="bad" label={`Overdue ${item.dueDate}`} />
                      ) : (
                        <span>Due {item.dueDate}</span>
                      )
                    ) : (
                      <span>No due date</span>
                    )
                  }
                />
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

/* ==========================================================================
   B — DAY SPINE
   ========================================================================== */

function SpecB() {
  return (
    <div className="spec-strip">
      <span className="spec-label">System B</span>
      <a className="b-link" href="#spec">
        Card link
      </a>
      <a className="b-link-inline" href="#spec">
        inline link
      </a>
      <span className="b-pill b-pill-ok">
        <Check size={11} /> Ready
      </span>
      <span className="b-pill b-pill-warn">Preparing</span>
      <span className="b-pill b-pill-bad">Failed</span>
      <span className="b-pill">Neutral</span>
    </div>
  );
}

function PillB({ tone, label }: { tone: Tone; label: string }) {
  const cls = tone === "none" ? "b-pill" : `b-pill b-pill-${tone}`;
  return <span className={cls}>{label}</span>;
}

function SpineB({
  meetings,
}: {
  meetings: {
    meetingId: string;
    title: string;
    startAt: string;
    briefStatus: DailyBriefingBriefStatus;
  }[];
}) {
  return (
    <ul className="b-spine">
      {meetings.map((m) => {
        const s = STATUS[m.briefStatus];
        return (
          <li className="b-node" key={m.meetingId}>
            <span className="b-node-time">
              {clockTime(m.startAt)}
              <span className="b-node-day">{weekday(m.startAt)}</span>
            </span>
            <span className={`b-node-dot${s.tone === "none" ? "" : ` is-${s.tone}`}`} />
            <div className="b-card">
              <div className="b-card-head">
                <Link className="b-link" to={`/meetings/${m.meetingId}`}>
                  {m.title}
                </Link>
                <PillB tone={s.tone} label={s.label} />
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export function VariantB({ data }: { data: ProtoData }) {
  const { briefing, weekly, actionItems, meetingTitles, busy, onRefresh } = data;
  const todayCount = briefing?.briefing?.meetings.length ?? 0;
  const weekCount = weekly?.briefing?.meetings.length ?? 0;
  const openCount = actionItems?.length ?? 0;
  const overdue = (actionItems ?? []).filter((i) => i.dueDate && isOverdue(i.dueDate)).length;

  return (
    <div className="mproto-b">
      <SpecB />
      <header className="b-head">
        <p className="b-title" aria-hidden="true">
          Meeting Wizard
        </p>
        <p>
          Your day on a spine — every meeting at its hour, with what it still needs docked
          alongside.
        </p>
        <div className="b-stats">
          <div>
            <span className="b-stat-n">{todayCount}</span>
            <span className="b-stat-l">Today</span>
          </div>
          <div>
            <span className="b-stat-n">{weekCount}</span>
            <span className="b-stat-l">This week</span>
          </div>
          <div>
            <span className="b-stat-n">{openCount}</span>
            <span className="b-stat-l">Open actions</span>
          </div>
          <div>
            <span className="b-stat-n">{overdue}</span>
            <span className="b-stat-l">Overdue</span>
          </div>
        </div>
        <div className="b-actions">
          <Link className="b-btn b-btn-primary" to="/meetings/brief">
            <FileText size={15} /> Brief journey
          </Link>
          <Link className="b-btn" to="/meeting-debrief">
            <ListTodo size={15} /> Debrief journey
          </Link>
          <button type="button" className="b-btn" onClick={onRefresh} aria-disabled={busy}>
            <RefreshCw size={15} /> {busy ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </header>

      <div className="b-grid">
        <div>
          <section className="b-block">
            <div className="b-section-head">
              <h2>Today</h2>
              <span>{briefing?.briefing?.summary ?? "—"}</span>
            </div>
            {briefing?.error ? (
              <p className="proto-error">{briefing.error}</p>
            ) : briefing?.briefing && briefing.briefing.meetings.length > 0 ? (
              <SpineB meetings={briefing.briefing.meetings} />
            ) : (
              <p className="b-empty">Nothing on the calendar today.</p>
            )}
          </section>

          <section className="b-block">
            <div className="b-section-head">
              <h2>This week</h2>
              <span>{weekly?.briefing?.ranking ?? "—"}</span>
            </div>
            {weekly?.error ? (
              <p className="proto-error">{weekly.error}</p>
            ) : weekly?.briefing && weekly.briefing.meetings.length > 0 ? (
              <SpineB meetings={weekly.briefing.meetings} />
            ) : (
              <p className="b-empty">Nothing scheduled this week.</p>
            )}
          </section>
        </div>

        <aside className="b-dock">
          <h2>
            <Inbox size={14} /> Your actions
          </h2>
          {actionItems === null ? (
            <p className="b-empty">Loading…</p>
          ) : actionItems.length === 0 ? (
            <p className="b-empty">Nothing open. Nice.</p>
          ) : (
            <ul className="b-tasks">
              {actionItems.map((item) => {
                const overdueItem = Boolean(item.dueDate && isOverdue(item.dueDate));
                return (
                  <li
                    key={`${item.runId}:${item.index}`}
                    className={overdueItem ? "b-task is-overdue" : "b-task"}
                  >
                    <Link
                      className="b-task-title"
                      to={
                        item.meetingId
                          ? `/meetings/${item.meetingId}`
                          : `/meeting-debrief/${encodeURIComponent(item.runId)}`
                      }
                    >
                      {item.title}
                    </Link>
                    <span className="b-task-meta">
                      {item.dueDate
                        ? `${overdueItem ? "Overdue" : "Due"} ${item.dueDate}`
                        : "No due date"}
                      {item.meetingId && meetingTitles.get(item.meetingId)
                        ? ` · ${meetingTitles.get(item.meetingId)}`
                        : ""}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </aside>
      </div>
    </div>
  );
}

/* ==========================================================================
   C — EDITORIAL LEDGER
   ========================================================================== */

function SpecC() {
  return (
    <div className="spec-strip">
      <span className="spec-label">System C</span>
      <a className="c-link c-serif" href="#spec">
        Ledger link
      </a>
      <a className="c-link-inline" href="#spec">
        inline link
      </a>
      <button type="button" className="c-btn c-btn-primary">
        Primary
      </button>
      <button type="button" className="c-btn">
        Secondary
      </button>
      <span className="c-state c-state-ok">Ready</span>
      <span className="c-state c-state-warn">Preparing</span>
      <span className="c-state c-state-bad">Failed</span>
      <span className="c-state">No brief</span>
    </div>
  );
}

function StateC({ tone, label }: { tone: Tone; label: string }) {
  const cls = tone === "none" ? "c-state" : `c-state c-state-${tone}`;
  return <span className={cls}>{label}</span>;
}

function LedgerC({
  meetings,
}: {
  meetings: {
    meetingId: string;
    title: string;
    startAt: string;
    briefStatus: DailyBriefingBriefStatus;
  }[];
}) {
  return (
    <ul className="c-ledger">
      {meetings.map((m) => {
        const s = STATUS[m.briefStatus];
        return (
          <li className="c-line" key={m.meetingId}>
            <Link className="c-link c-serif" to={`/meetings/${m.meetingId}`}>
              {m.title}
            </Link>
            <span className="c-leader" aria-hidden="true" />
            <StateC tone={s.tone} label={s.label} />
            <span className="c-time">{formatMeetingTime(m.startAt)}</span>
          </li>
        );
      })}
    </ul>
  );
}

export function VariantC({ data }: { data: ProtoData }) {
  const { briefing, weekly, actionItems, meetingTitles, index, busy, onRefresh } = data;
  return (
    <div className="mproto-c">
      <SpecC />
      <header className="c-head">
        <span className="c-kicker">Meeting Wizard</span>
        <p className="c-title c-serif" aria-hidden="true">
          The week, prepared.
        </p>
        <p className="c-standfirst">
          Every meeting the workspace knows about — from your calendar, and from transcripts of
          meetings that were never on it. Each carries its brief beforehand and its debrief
          afterwards.
          {index?.historyBeginsAt ? (
            <>
              {" "}
              History begins{" "}
              <time dateTime={index.historyBeginsAt}>
                {formatMeetingDate(index.historyBeginsAt)}
              </time>
              .
            </>
          ) : null}
        </p>
        <div className="c-actions">
          <Link className="c-btn c-btn-primary" to="/meetings/brief">
            Brief journey
          </Link>
          <Link className="c-btn" to="/meeting-debrief">
            Debrief journey
          </Link>
          <button type="button" className="c-btn" onClick={onRefresh} aria-disabled={busy}>
            <RefreshCw size={13} /> {busy ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </header>

      <div className="c-body">
        <section className="c-section">
          <div className="c-section-head">
            <span className="c-num">01</span>
            <h2>Today</h2>
            <span className="c-count">
              {plural(briefing?.briefing?.meetings.length ?? 0, "meeting")}
            </span>
          </div>
          {briefing?.error ? (
            <p className="proto-error">{briefing.error}</p>
          ) : briefing?.briefing && briefing.briefing.meetings.length > 0 ? (
            <>
              <p className="c-note">{briefing.briefing.summary}</p>
              <LedgerC meetings={briefing.briefing.meetings} />
            </>
          ) : (
            <p className="c-empty">No meetings today.</p>
          )}
        </section>

        <section className="c-section">
          <div className="c-section-head">
            <span className="c-num">02</span>
            <h2>This week</h2>
            <span className="c-count">
              {plural(weekly?.briefing?.meetings.length ?? 0, "meeting")}
            </span>
          </div>
          {weekly?.error ? (
            <p className="proto-error">{weekly.error}</p>
          ) : weekly?.briefing && weekly.briefing.meetings.length > 0 ? (
            <>
              <p className="c-note">{weekly.briefing.ranking}</p>
              <LedgerC meetings={weekly.briefing.meetings} />
            </>
          ) : (
            <p className="c-empty">No meetings this week.</p>
          )}
        </section>

        <section className="c-section">
          <div className="c-section-head">
            <span className="c-num">03</span>
            <h2>Your action items</h2>
            <span className="c-count">{plural(actionItems?.length ?? 0, "open item")}</span>
          </div>
          {actionItems === null ? (
            <p className="c-empty">Loading…</p>
          ) : actionItems.length === 0 ? (
            <p className="c-empty">No open action items.</p>
          ) : (
            <ul className="c-ledger">
              {actionItems.map((item) => {
                const overdueItem = Boolean(item.dueDate && isOverdue(item.dueDate));
                return (
                  <li className="c-line" key={`${item.runId}:${item.index}`}>
                    <span>
                      <Link
                        className="c-link c-serif"
                        to={
                          item.meetingId
                            ? `/meetings/${item.meetingId}`
                            : `/meeting-debrief/${encodeURIComponent(item.runId)}`
                        }
                      >
                        {item.title}
                      </Link>
                      {item.meetingId && meetingTitles.get(item.meetingId) ? (
                        <span className="c-sub">from {meetingTitles.get(item.meetingId)}</span>
                      ) : null}
                    </span>
                    <span className="c-leader" aria-hidden="true" />
                    {item.dueDate ? (
                      <StateC
                        tone={overdueItem ? "bad" : "none"}
                        label={`${overdueItem ? "Overdue" : "Due"} ${item.dueDate}`}
                      />
                    ) : (
                      <StateC tone="none" label="No due date" />
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

/* ==========================================================================
   The state read-out the prototype rules ask for.
   ========================================================================== */

export function ProtoState({ data, variant }: { data: ProtoData; variant: string }) {
  const lines = [
    `variant=${variant}`,
    `today=${data.briefing?.briefing?.meetings.length ?? "null"} week=${
      data.weekly?.briefing?.meetings.length ?? "null"
    } actions=${data.actionItems?.length ?? "null"}`,
    `stale: daily=${String(data.briefing?.stale ?? "—")} weekly=${String(
      data.weekly?.stale ?? "—",
    )}`,
    `errors: daily=${data.briefing?.error ?? "none"} weekly=${
      data.weekly?.error ?? "none"
    } actions=${data.actionItemsError ?? "none"}`,
    `busy=${String(data.busy)} historyBeginsAt=${data.index?.historyBeginsAt ?? "—"}`,
  ];
  return (
    <pre className="mproto-state">
      {lines.join("\n")}
      {"\n"}
      <AlertTriangle size={11} style={{ verticalAlign: "-1px" }} /> prototype — dev builds only
      {"  "}
      <Clock size={11} style={{ verticalAlign: "-1px" }} /> read-only except Refresh
    </pre>
  );
}
