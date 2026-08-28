import { eligibilityReason, isEligibleMeeting } from "./eligibility.js";
import type { CalendarEvent } from "./calendar.js";
import type { MeetingBriefFixtureEvent } from "@chief-of-staff-demo/shared";
import { materialFingerprint } from "./revision.js";

export type SnapshotSource = CalendarEvent | MeetingBriefFixtureEvent;

/**
 * Snapshot eligibility check (issue://84, ADR-0033).
 * Freezes current event, occurrence, version and validates eligibility
 * using Internal Domains + ownerEmail. Returns ineligibility reason when skipped.
 */
export function snapshotEligibility(
  event: SnapshotSource,
  internalDomains: string[],
  ownerEmail: string | null,
): { eligible: boolean; reason: string } {
  const eligible = isEligibleMeeting(
    event as unknown as CalendarEvent,
    internalDomains,
    ownerEmail,
  );
  const reason = eligibilityReason(event as unknown as CalendarEvent, internalDomains, ownerEmail);
  return { eligible, reason };
}

export interface FrozenSnapshot {
  calendarId: string;
  eventId: string;
  occurrenceId: string;
  occurrenceKey: string;
  version: string;
  materialFingerprint: string;
  summary: string;
  description?: string | undefined;
  startAt: string;
  endAt: string;
  location: string | null;
  conferenceLink: string | null;
  organizer?: { email: string; displayName?: string } | undefined;
  attendees: SnapshotSource["attendees"];
  attachments?: string[] | undefined;
  capturedAt: string;
}

/** Build frozen snapshot payload persisted as snapshot.json (retains version + material fingerprint). */
export function buildFrozenSnapshot(
  event: SnapshotSource,
  occurrenceKey: string,
  capturedAt: string,
): FrozenSnapshot {
  return {
    calendarId: event.calendarId,
    eventId: event.eventId,
    occurrenceId: event.occurrenceId,
    occurrenceKey,
    version: event.version,
    materialFingerprint: materialFingerprint(event),
    summary: event.summary,
    ...(event.description !== undefined ? { description: event.description } : {}),
    startAt: event.startAt,
    endAt: event.endAt,
    location: event.location ?? null,
    conferenceLink: event.conferenceLink ?? null,
    ...(event.organizer !== undefined ? { organizer: event.organizer } : {}),
    attendees: event.attendees,
    ...(event.attachments !== undefined ? { attachments: event.attachments } : {}),
    capturedAt,
  };
}
