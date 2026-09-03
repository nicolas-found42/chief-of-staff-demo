import type { CalendarProvider } from "./calendar.js";
import { eligibilityReason, isRecordableMeeting, meetingParticipants } from "./eligibility.js";
import { ineligibilityOf, MEETING_BRIEF_CALENDAR_ID, occurrenceKeyFor } from "./intake.js";
import type { WorkspaceMeetings } from "../../meetings/store.js";

/**
 * The one backward read of Calendar (issue #152).
 *
 * Calendar is read forward only, so a Workspace that starts after its own
 * history would never have Meetings for the years its Transcripts cover. This
 * read goes once from the oldest Transcript's date through to now, and the
 * qualifying occurrences become Meetings through the same store path forward
 * intake uses — a Meeting collected from history is indistinguishable from one
 * collected going forward.
 *
 * The read is marked once it has completed; every later call is a no-op. A
 * failed read writes no mark, so the next reconcile retries it. A Workspace
 * with no Transcripts collects nothing and is not marked — the read waits
 * until there is a bound to reach back to.
 */
export async function collectMeetingHistory(args: {
  provider: CalendarProvider;
  meetings: WorkspaceMeetings;
  /** The oldest Transcript's date; null when the Workspace holds no Transcripts. */
  oldestTranscriptAt: string | null;
  ownerEmail: string | null | (() => string | null);
  now: Date;
  calendarId?: string;
  log?: (message: string) => void;
}): Promise<{ recorded: number; marked: boolean }> {
  if (args.meetings.historyMark() !== null) return { recorded: 0, marked: true };
  if (args.oldestTranscriptAt === null) return { recorded: 0, marked: false };

  const calendarId = args.calendarId ?? MEETING_BRIEF_CALENDAR_ID;
  const ownerEmail = typeof args.ownerEmail === "function" ? args.ownerEmail() : args.ownerEmail;
  const result = await args.provider.listEvents({
    calendarId,
    syncToken: null,
    timeMin: args.oldestTranscriptAt,
    timeMax: args.now.toISOString(),
  });

  /* A history read must not move the incremental sync state: the returned
     token describes a window this reader never reconciled schedules against. */
  void result.nextSyncToken;

  let recorded = 0;
  for (const event of result.events) {
    if (!isRecordableMeeting(event, ownerEmail)) continue;
    const reason = eligibilityReason(event, ownerEmail);
    args.meetings.upsertFromCalendar({
      occurrenceKey: occurrenceKeyFor(event),
      calendarEventId: event.eventId,
      occurrenceId: event.occurrenceId,
      title: event.summary,
      startAt: event.startAt,
      endAt: event.endAt,
      participants: meetingParticipants(event, ownerEmail),
      cancelled: event.status === "cancelled",
      ineligibleReason: reason === "eligible" ? null : ineligibilityOf(reason),
    });
    recorded += 1;
  }

  args.meetings.writeHistoryMark({
    collectedAt: args.now.toISOString(),
    from: args.oldestTranscriptAt,
  });
  args.log?.(
    `meeting history: read ${result.events.length} occurrences back to ${args.oldestTranscriptAt}, recorded ${recorded}`,
  );
  return { recorded, marked: true };
}
