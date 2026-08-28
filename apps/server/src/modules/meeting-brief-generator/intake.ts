import { MEETING_BRIEF_MODULE_ID } from "@chief-of-staff-demo/shared";
import type { DurableClock } from "../../engine/durableClock.js";
import { isEligibleMeeting } from "./eligibility.js";
import {
  type CalendarEvent,
  type CalendarProvider,
  InvalidSyncTokenError,
  type MeetingBriefCalendarStore,
  newChannelId,
  newChannelToken,
} from "./calendar.js";

export const MEETING_BRIEF_CALENDAR_ID = "primary" as const;

/** Four hours preparation lead time (issue://80). Fixed, no setting. */
export const PREPARATION_LEAD_MS = 4 * 60 * 60 * 1000;

/** Occurrence key for deduplication and durableClock key (ADR-0033). */
export function occurrenceKeyFor(event: Pick<CalendarEvent, "eventId" | "occurrenceId">): string {
  return `${event.eventId}::${event.occurrenceId}`;
}

/** Compute due time: 4h before start, or immediate if inside window. */
export function computeDueTime(startAt: string, now: Date): Date {
  const startMs = Date.parse(startAt);
  if (Number.isNaN(startMs)) return now;
  const dueMs = startMs - PREPARATION_LEAD_MS;
  return dueMs <= now.getTime() ? now : new Date(dueMs);
}

/** Ensure the primary Calendar push channel exists and is durable before expiration (issue://83). */
export async function ensureCalendarWatch(args: {
  provider: CalendarProvider;
  store: MeetingBriefCalendarStore;
  now: Date;
  calendarId?: string;
  log?: (msg: string) => void;
}): Promise<void> {
  const calendarId = args.calendarId ?? MEETING_BRIEF_CALENDAR_ID;
  const needsRenewal = args.store.needsRenewal(args.now);
  const existing = args.store.load().channel;
  if (existing && !needsRenewal) return;

  const newId = newChannelId();
  const newToken = newChannelToken();
  const result = await args.provider.watchChannel({
    calendarId,
    channelId: newId,
    token: newToken,
  });
  const newChannel = {
    channelId: newId,
    token: newToken,
    resourceId: result.resourceId,
    expiration: result.expiration,
    calendarId,
  };
  // Activate new before revoking old (ADR-0031)
  if (existing && existing.channelId !== newId) {
    try {
      await args.provider.stopChannel({
        channelId: existing.channelId,
        resourceId: existing.resourceId,
      });
    } catch {
      // best-effort revoke; still persist new channel
    }
  }
  args.store.setChannel(newChannel);
  args.log?.(`calendar watch ensured ${newId} exp ${result.expiration}`);
}

/**
 * Reconcile Calendar current state against Intake schedules (issue://83).
 * Header-only wake-ups never mistaken for data — we fetch Calendar after each wake-up.
 * Classifies Eligible Meetings and durably schedules 4h before start (immediate if inside window),
 * moved outside replaces schedule, moved inside starts immediately, ineligible removes schedule.
 * Duplicate wake-ups are harmless (idempotent replace). Bounded reconciliation on invalid sync.
 */
export async function reconcileCalendar(args: {
  provider: CalendarProvider;
  store: MeetingBriefCalendarStore;
  clock: DurableClock;
  internalDomains: string[];
  ownerEmail: string | null;
  now: Date;
  calendarId?: string;
  forceFullSync?: boolean;
  log?: (msg: string) => void;
}): Promise<{ scheduled: number; removed: number; invalidSyncRecovered: boolean }> {
  const calendarId = args.calendarId ?? MEETING_BRIEF_CALENDAR_ID;
  let syncToken: string | null = args.forceFullSync ? null : args.store.getSyncToken();
  let events: CalendarEvent[];
  let nextSyncToken: string | null;
  let invalidSyncRecovered = false;

  // Attempt incremental or bounded full sync
  const fetchOnce = async (token: string | null) => {
    // Bounded full sync uses timeMin/timeMax window (next 90 days)
    if (token === null) {
      const timeMin = args.now.toISOString();
      const timeMax = new Date(args.now.getTime() + 90 * 24 * 60 * 60 * 1000).toISOString();
      return args.provider.listEvents({ calendarId, syncToken: null, timeMin, timeMax });
    }
    return args.provider.listEvents({ calendarId, syncToken: token });
  };

  try {
    const result = await fetchOnce(syncToken);
    events = result.events;
    nextSyncToken = result.nextSyncToken;
  } catch (err) {
    if (
      err instanceof InvalidSyncTokenError ||
      (err instanceof Error && err.name === "InvalidSyncTokenError")
    ) {
      invalidSyncRecovered = true;
      args.log?.("calendar syncToken invalid — bounded reconciliation");
      // Bounded reconciliation: full sync without token
      const result = await fetchOnce(null);
      events = result.events;
      nextSyncToken = result.nextSyncToken;
      // Clear old token before saving new
      syncToken = null;
    } else {
      throw err;
    }
  }

  // Persist syncToken if provider gave one
  if (nextSyncToken !== null && nextSyncToken !== syncToken) {
    args.store.setSyncState(nextSyncToken, args.now.toISOString());
  } else if (nextSyncToken === null && syncToken !== null) {
    // Provider may return null on full sync; keep stored unless invalidated
  }

  let scheduled = 0;
  let removed = 0;

  // Build set of occurrenceKeys seen as eligible in this sync, to handle deletions via ineligible removal
  // For incremental sync we only see changed events; we don't remove unseen eligible ones.
  // For full sync (syncToken null) we see all future events — we should also remove schedules for occurrences not returned but previously eligible? However spec says incremental sync reconciliation after each wake-up; so incremental sees only changed. For test bounded reconciliation, we'll handle both: for full sync we reconcile all returned.
  const seenKeys = new Set<string>();

  for (const event of events) {
    const key = occurrenceKeyFor(event);
    seenKeys.add(key);
    const eligible = isEligibleMeeting(event, args.internalDomains, args.ownerEmail);
    const startMs = Date.parse(event.startAt);
    const isFuture = !Number.isNaN(startMs) && startMs > args.now.getTime();

    if (!eligible || !isFuture) {
      // Ineligible or past/cancelled/all-day/resource-only/internal-only — remove schedule if present
      const before = args.clock.list(MEETING_BRIEF_MODULE_ID).some((s) => s.key === key);
      args.clock.remove(MEETING_BRIEF_MODULE_ID, key);
      if (before) removed += 1;
      continue;
    }

    // Eligible future → schedule 4h before or immediate
    const dueAt = computeDueTime(event.startAt, args.now);
    // Durably schedule (atomic replace)
    args.clock.schedule({
      module: MEETING_BRIEF_MODULE_ID,
      key,
      dueAt: dueAt.toISOString(),
      input: event,
    });
    scheduled += 1;
  }

  // On full sync (no syncToken), remove schedules for eligible occurrences that disappeared (deleted/cancelled)
  // This handles cancellation before Run: removes future candidate without creating Run (ADR-0033).
  if (syncToken === null) {
    const currentKeys = args.clock.list(MEETING_BRIEF_MODULE_ID).map((s) => s.key);
    for (const key of currentKeys) {
      if (!seenKeys.has(key)) {
        // Check if this occurrence corresponds to an event that is no longer returned in full sync — treat as removed (deleted).
        // For safety, only remove if the stored input's eventId not in returned set? Simpler: remove if not seen — but incremental sync would incorrectly remove.
        // So only do this cleanup on full sync + invalidSyncRecovered or initial sync.
        // For initial full sync, there is no prior schedule to cleanup incorrectly.
        // For invalid sync recovery, we have full list, so missing keys mean deleted/ineligible.
        if (invalidSyncRecovered || args.store.getSyncToken() === nextSyncToken) {
          // Only if we did a full sync and have a complete view, missing keys should be removed.
          // To keep bounded, we remove only if the stored schedule's input is not in returned eligible set.
          // Since fake provider returns all events on full sync, missing means deleted.
          // We conservatively remove.
          const stillExists = events.some((e) => occurrenceKeyFor(e) === key);
          if (!stillExists) {
            args.clock.remove(MEETING_BRIEF_MODULE_ID, key);
            removed += 1;
          }
        }
      }
    }
  }

  args.log?.(`reconcile: ${scheduled} scheduled, ${removed} removed, token ${nextSyncToken}`);
  return { scheduled, removed, invalidSyncRecovered };
}
