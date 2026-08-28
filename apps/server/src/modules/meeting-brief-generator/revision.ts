/* eslint-disable @typescript-eslint/no-unnecessary-condition -- revision compares optional Calendar fields that may be absent */
import type { CalendarEvent } from "./calendar.js";
import type { MeetingBriefFixtureEvent } from "@chief-of-staff-demo/shared";

/**
 * Material Calendar change detection (ADR-0033, issue://84).
 *
 * Material fields (consumed by brief/delivery): title (=summary), description,
 * timing (startAt/endAt), location, conference link, attached Docs (attachments),
 * organizer, guest identity/list, invitation response.
 *
 * Unused metadata (colorId, etag, visibility, transparency, created, updated,
 * calendarId etc.) is ignored.
 */

export type AnyEvent = CalendarEvent | MeetingBriefFixtureEvent;

export interface MaterialSnapshot {
  summary: string;
  description: string;
  startAt: string;
  endAt: string;
  location: string | null;
  conferenceLink: string | null;
  attachments: string[];
  organizerEmail: string | null;
  attendees: Array<{
    email: string;
    responseStatus: string;
    organizer: boolean;
    resource: boolean;
  }>;
}

/** Produce deterministic material snapshot for comparison (ADR-0033). */
export function materialSnapshot(event: AnyEvent): MaterialSnapshot {
  const attachments = [...(event.attachments ?? [])].sort();
  const organizerEmail = event.organizer?.email?.trim().toLowerCase() ?? null;
  const attendees = (event.attendees ?? [])
    .map((a) => ({
      email: a.email.trim().toLowerCase(),
      responseStatus: a.responseStatus,
      organizer: Boolean(a.organizer),
      resource: Boolean(a.resource),
    }))
    .sort(
      (a, b) => a.email.localeCompare(b.email) || a.responseStatus.localeCompare(b.responseStatus),
    );
  return {
    summary: event.summary ?? "",
    description: event.description ?? "",
    startAt: event.startAt,
    endAt: event.endAt,
    location: event.location ?? null,
    conferenceLink: event.conferenceLink ?? null,
    attachments,
    organizerEmail,
    attendees,
  };
}

export function materialFingerprint(event: AnyEvent): string {
  return JSON.stringify(materialSnapshot(event));
}

export function isMaterialChange(prev: AnyEvent, next: AnyEvent): boolean {
  return materialFingerprint(prev) !== materialFingerprint(next);
}

/** Whether two events have identical material content (ignoring version/ignored metadata). */
export function isSameMaterialVersion(prev: AnyEvent, next: AnyEvent): boolean {
  return !isMaterialChange(prev, next);
}

/** Find the latest Run id for an occurrenceKey among a list of entries (by createdAt desc). */
export function latestRunIdForOccurrence(
  entries: Array<{ occurrenceKey: string; runId: string; createdAt: string }>,
  occurrenceKey: string,
): string | null {
  let latest: { runId: string; createdAt: string } | null = null;
  for (const e of entries) {
    if (e.occurrenceKey !== occurrenceKey) continue;
    if (!latest || Date.parse(e.createdAt) > Date.parse(latest.createdAt)) latest = e;
  }
  return latest?.runId ?? null;
}
