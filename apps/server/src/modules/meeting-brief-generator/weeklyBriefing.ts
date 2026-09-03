import { DateTime } from "luxon";
import {
  MEETING_BRIEF_MODULE_ID,
  type DailyBriefingBriefStatus,
  type MeetingBriefRunResult,
  type WeeklyBriefing,
} from "@chief-of-staff-demo/shared";
import type { WorkspaceMeetings } from "../../meetings/store.js";
import type { Runs } from "../../runs.js";
import { isInternalDomain } from "./eligibility.js";
import { sweepWindowFor } from "./intake.js";

/**
 * The Weekly Briefing read model (issue #161): the week ahead, derived on read
 * from the coming week's Meetings and their Meeting Briefs (ADR-0005) — the
 * Briefs the Sunday sweep prepares. Pure derivation — no Run is started and
 * nothing is persisted here. The host owns the Monday schedule and the error
 * state; this file only computes.
 */

export interface WeeklyBriefingDeps {
  meetings: WorkspaceMeetings;
  runs: Runs;
}

/** The owner-timezone sweep week covering `now`: Sunday start id and UTC bounds. */
export function weekBoundsFor(
  now: Date,
  timezone: string,
): { weekStart: string; startMs: number; endMs: number } {
  const { windowStart, windowEnd } = sweepWindowFor(now, timezone);
  let local = DateTime.fromJSDate(windowStart, { zone: "utc" }).setZone(timezone);
  if (!local.isValid) local = DateTime.fromJSDate(windowStart, { zone: "utc" });
  return {
    weekStart: local.toISODate() ?? local.toUTC().toISODate() ?? "unknown",
    startMs: windowStart.getTime(),
    endMs: windowEnd.getTime(),
  };
}

/**
 * Deterministic importance — which meetings matter most. An external guest
 * outweighs headcount, and a ready Brief outranks a missing one. Attendee
 * count, external presence, and Brief readiness only; no new signals.
 */
export function weeklyImportance(input: {
  guestCount: number;
  hasExternal: boolean;
  briefStatus: DailyBriefingBriefStatus;
}): number {
  let score = Math.max(0, input.guestCount);
  if (input.hasExternal) score += 10;
  if (input.briefStatus === "ready") score += 5;
  else if (input.briefStatus === "pending") score += 2;
  return score;
}

/**
 * The week's Weekly Briefing, or null when the week holds no Meetings. Reads
 * the Workspace's Meetings for the owner-timezone sweep week plus the Brief
 * Runs index for their Brief state. Throws only when the underlying stores
 * throw; the host turns that into the surfaced error state.
 */
export function buildWeeklyBriefing(
  deps: WeeklyBriefingDeps,
  now: Date,
  timezone: string,
  internalDomains: string[] = [],
): WeeklyBriefing | null {
  const { weekStart, startMs, endMs } = weekBoundsFor(now, timezone);
  const weeks = deps.meetings.list().filter((meeting) => {
    if (meeting.cancelled) return false;
    const startMsOf = Date.parse(meeting.startAt);
    return !Number.isNaN(startMsOf) && startMsOf >= startMs && startMsOf < endMs;
  });
  if (weeks.length === 0) return null;

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

  const meetings = weeks.map((meeting) => {
    let briefStatus: DailyBriefingBriefStatus = "missing";
    if (meeting.occurrenceKey) {
      if (doneKeys.has(meeting.occurrenceKey)) briefStatus = "ready";
      else if (activeKeys.has(meeting.occurrenceKey)) briefStatus = "pending";
    }
    const guests = meeting.participants.filter((participant) => !participant.self);
    const hasExternal = guests.some(
      (participant) =>
        participant.email !== "" && !isInternalDomain(participant.email, internalDomains),
    );
    return {
      meetingId: meeting.id,
      title: meeting.title,
      startAt: meeting.startAt,
      importance: weeklyImportance({ guestCount: guests.length, hasExternal, briefStatus }),
      briefStatus,
    };
  });
  meetings.sort(
    (a, b) =>
      b.importance - a.importance ||
      a.startAt.localeCompare(b.startAt) ||
      a.meetingId.localeCompare(b.meetingId),
  );
  const ready = meetings.filter((entry) => entry.briefStatus === "ready").length;
  const noun = meetings.length === 1 ? "Meeting" : "Meetings";
  const readyNoun = ready === 1 ? "Brief" : "Briefs";
  const top = meetings[0]?.title ?? "—";
  return {
    weekStart,
    meetings,
    ranking:
      `${meetings.length} ${noun} this week · ` + `${ready} ${readyNoun} ready · ` + `top: ${top}`,
  };
}
