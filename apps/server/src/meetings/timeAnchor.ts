import type { Meeting } from "@chief-of-staff-demo/shared";

/**
 * The evidenced day a meeting happened on, and the zone that makes it a day
 * (#356, ADR-0082).
 *
 * "Tomorrow" in a transcript is a real date only if the meeting's own day is
 * known, and a day is only a day in a timezone: 22:30 UTC is already the next
 * morning in Auckland. Both halves have to be evidenced. The Workspace's own
 * timezone is deliberately not a fallback — it is the machine the app happens
 * to run on, which says nothing about where the meeting was.
 */
export interface MeetingTimeAnchor {
  /** The meeting's civil date, YYYY-MM-DD, in `timeZone`. */
  date: string;
  /** IANA zone the date is a date in. */
  timeZone: string;
  basis: "calendar-occurrence";
}

/**
 * The anchor a Meeting supplies, or null when it supplies none. Null is a
 * real answer: relative timing then stays the words that were said.
 */
export function meetingTimeAnchor(meeting: Meeting | null): MeetingTimeAnchor | null {
  if (meeting === null) return null;
  /* A Meeting a Transcript owns has a start derived from the file it came
     from, not from an occurrence anyone scheduled. */
  if (meeting.occurrenceKey === null) return null;
  const timeZone = meeting.timeZone;
  if (!timeZone) return null;
  const startedAt = Date.parse(meeting.startAt);
  if (!Number.isFinite(startedAt)) return null;
  const date = civilDate(new Date(startedAt), timeZone);
  if (date === null) return null;
  return { date, timeZone, basis: "calendar-occurrence" };
}

/**
 * The calendar date an instant falls on in a zone. Null when the runtime does
 * not know the zone: an unknown zone is missing evidence, not a reason to
 * quietly use another one.
 */
function civilDate(at: Date, timeZone: string): string | null {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(at);
  } catch {
    return null;
  }
}

/**
 * The meeting day plus the next 7 civil days in the meeting's own timezone.
 * Uses civil-date arithmetic rather than 24-hour additions so DST changes
 * and day boundaries cannot shift dates (#356, ADR-0082).
 */
export function referenceDaysForAnchor(anchor: MeetingTimeAnchor): {
  date: string;
  weekdayShort: string;
  weekdayLong: string;
}[] {
  const match = anchor.date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return [];
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const weekdayShortFmt = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" });
  const weekdayLongFmt = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "UTC" });
  const days: { date: string; weekdayShort: string; weekdayLong: string }[] = [];
  for (let offset = 0; offset < 8; offset++) {
    const dt = new Date(Date.UTC(y, m - 1, d + offset, 12, 0, 0));
    const yyyy = dt.getUTCFullYear();
    const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(dt.getUTCDate()).padStart(2, "0");
    days.push({
      date: `${yyyy}-${mm}-${dd}`,
      weekdayShort: weekdayShortFmt.format(dt),
      weekdayLong: weekdayLongFmt.format(dt),
    });
  }
  return days;
}
