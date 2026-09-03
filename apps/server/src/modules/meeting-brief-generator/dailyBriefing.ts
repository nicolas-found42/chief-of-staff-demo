import { DateTime } from "luxon";
import {
  MEETING_BRIEF_MODULE_ID,
  type DailyBriefing,
  type DailyBriefingBriefStatus,
  type MeetingBriefRunResult,
} from "@chief-of-staff-demo/shared";
import type { WorkspaceMeetings } from "../../meetings/store.js";
import type { Runs } from "../../runs.js";

/**
 * The Daily Briefing read model (issue #160): the day ahead, derived on read
 * from the day's Meetings and their Meeting Briefs (ADR-0005). Pure
 * derivation — no Run is started and nothing is persisted here. The host owns
 * the morning schedule and the error state; this file only computes.
 */

export interface DailyBriefingDeps {
  meetings: WorkspaceMeetings;
  runs: Runs;
}

/** The owner-timezone calendar day covering `now`: day id and UTC bounds. */
export function dayBoundsFor(
  now: Date,
  timezone: string,
): { date: string; startMs: number; endMs: number } {
  let local = DateTime.fromJSDate(now, { zone: "utc" }).setZone(timezone);
  if (!local.isValid) local = DateTime.fromJSDate(now, { zone: "utc" });
  const start = local.startOf("day");
  const end = start.plus({ days: 1 });
  return {
    date: start.toISODate() ?? start.toUTC().toISODate() ?? "unknown",
    startMs: start.toMillis(),
    endMs: end.toMillis(),
  };
}

/**
 * The day's Daily Briefing, or null when the day holds no Meetings. Reads the
 * Workspace's Meetings for the owner-timezone day plus the Brief Runs index
 * for their Brief state. Throws only when the underlying stores throw; the
 * host turns that into the surfaced error state.
 */
export function buildDailyBriefing(
  deps: DailyBriefingDeps,
  now: Date,
  timezone: string,
): DailyBriefing | null {
  const { date, startMs, endMs } = dayBoundsFor(now, timezone);
  const todays = deps.meetings
    .list()
    .filter((meeting) => {
      if (meeting.cancelled) return false;
      const startMsOf = Date.parse(meeting.startAt);
      return !Number.isNaN(startMsOf) && startMsOf >= startMs && startMsOf < endMs;
    })
    .sort((a, b) => a.startAt.localeCompare(b.startAt));
  if (todays.length === 0) return null;

  const doneKeys = new Set<string>();
  const activeKeys = new Set<string>();
  for (const summary of deps.runs.list({ module: MEETING_BRIEF_MODULE_ID }).runs) {
    const meta = deps.runs.open(summary.id)?.read();
    const key = meta?.externalId;
    if (!key) continue;
    if (meta.status === "done") {
      const result = deps.runs.detail(summary.id)?.result as MeetingBriefRunResult | null;
      if (result?.meetingBrief) doneKeys.add(key);
    } else if (
      meta.status === "pending" ||
      meta.status === "running" ||
      meta.status === "blocked"
    ) {
      activeKeys.add(key);
    }
  }

  const meetings = todays.map((meeting) => {
    let briefStatus: DailyBriefingBriefStatus = "missing";
    if (meeting.occurrenceKey) {
      if (doneKeys.has(meeting.occurrenceKey)) briefStatus = "ready";
      else if (activeKeys.has(meeting.occurrenceKey)) briefStatus = "pending";
    }
    return {
      meetingId: meeting.id,
      title: meeting.title,
      startAt: meeting.startAt,
      briefStatus,
    };
  });
  const ready = meetings.filter((entry) => entry.briefStatus === "ready").length;
  const noun = meetings.length === 1 ? "Meeting" : "Meetings";
  return {
    date,
    meetings,
    summary:
      `${meetings.length} ${noun} today · ` + `${ready} ${ready === 1 ? "Brief" : "Briefs"} ready`,
  };
}
