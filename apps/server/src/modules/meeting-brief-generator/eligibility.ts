import type { CalendarAttendee, CalendarEvent } from "./calendar.js";

/**
 * Consumer Domains — personal mailbox providers that remain external
 * but must not be treated as employer evidence (issue://80 #32, #31).
 * For eligibility they count as external guests; for employer inference they are ignored (later waves).
 */
const CONSUMER_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "yahoo.co.uk",
  "yahoo.fr",
  "yahoo.de",
  "yahoo.co.jp",
  "aol.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "protonmail.com",
  "proton.me",
  "pm.me",
  "zoho.com",
  "gmx.com",
  "gmx.de",
  "yandex.com",
  "yandex.ru",
  "mail.com",
  "hey.com",
]);

/** Normalize a domain for case-insensitive comparison after email parsing. */
function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase();
}

/** Extract domain from an email after normalized parsing; null if no @. */
export function extractDomain(email: string): string | null {
  const trimmed = email.trim();
  const atIdx = trimmed.lastIndexOf("@");
  if (atIdx === -1 || atIdx === trimmed.length - 1) return null;
  const domain = trimmed
    .slice(atIdx + 1)
    .trim()
    .toLowerCase();
  if (domain.length === 0) return null;
  return domain;
}

/** Whether this domain is a Consumer Domain (personal mailbox). */
export function isConsumerDomain(domain: string): boolean {
  return CONSUMER_DOMAINS.has(normalizeDomain(domain));
}

/** Whether an email's domain is contained in the normalized internalDomains set. */
function isInternalDomain(email: string, internalDomains: string[]): boolean {
  const domain = extractDomain(email);
  if (!domain) return false;
  const normalized = normalizeDomain(domain);
  for (const internal of internalDomains) {
    if (normalizeDomain(internal) === normalized) return true;
  }
  return false;
}

/** Whether this attendee is a room/resource and must be ignored as guest. */
function isResourceAttendee(attendee: CalendarAttendee): boolean {
  return attendee.resource === true;
}

/** Whether this attendee is an External Guest (outside every Internal Domain, not a resource). */
export function isExternalGuest(attendee: CalendarAttendee, internalDomains: string[]): boolean {
  if (isResourceAttendee(attendee)) return false;
  // No email? treat as not external (cannot classify)
  if (!attendee.email) return false;
  return !isInternalDomain(attendee.email, internalDomains);
}

/**
 * Eligible Meeting definition (issue://80 + #83, ADR-0032/33):
 * - timed (not all-day)
 * - non-cancelled (status !== "cancelled")
 * - not declined by owner (owner's responseStatus !== "declined")
 * - at least one non-declined External Guest (accepted/tentative/needsAction count; declined excluded)
 * - rooms/resources ignored, all-day excluded, Internal Domains case-insensitive normalized,
 *   Consumer Domains remain external without employer inference, recurring occurrences independent per occurrence identity.
 */
export function isEligibleMeeting(
  event: CalendarEvent,
  internalDomains: string[],
  ownerEmail: string | null,
): boolean {
  // Timed only — all-day excluded
  if (event.isAllDay === true) return false;

  // Require startAt; if missing, not timed
  if (!event.startAt || !event.endAt) return false;

  // Non-cancelled only
  if (event.status === "cancelled") return false;

  // Owner not declined — if ownerEmail provided, check matching attendee
  if (ownerEmail) {
    const normalizedOwner = ownerEmail.trim().toLowerCase();
    for (const attendee of event.attendees) {
      if (isResourceAttendee(attendee)) continue;
      if (attendee.email.trim().toLowerCase() === normalizedOwner) {
        if (attendee.responseStatus === "declined") return false;
        break;
      }
    }
    // Also check organizer if attendee list missing owner? Organizer declined not modeled; rely on attendee.
  }

  // At least one non-declined External Guest
  let hasExternalNonDeclined = false;
  for (const attendee of event.attendees) {
    if (isResourceAttendee(attendee)) continue;
    if (!isExternalGuest(attendee, internalDomains)) continue;
    // Consumer domains remain external — no extra filter
    if (attendee.responseStatus === "declined") continue;
    // accepted, tentative, needsAction count
    hasExternalNonDeclined = true;
    break;
  }
  return hasExternalNonDeclined;
}

/** Helper for tests: classify a meeting with diagnostic reason when ineligible. */
export function eligibilityReason(
  event: CalendarEvent,
  internalDomains: string[],
  ownerEmail: string | null,
): string {
  if (event.isAllDay === true) return "all_day_excluded";
  if (!event.startAt || !event.endAt) return "missing_time";
  if (event.status === "cancelled") return "cancelled";
  if (ownerEmail) {
    const normalizedOwner = ownerEmail.trim().toLowerCase();
    for (const attendee of event.attendees) {
      if (attendee.resource) continue;
      if (
        attendee.email.trim().toLowerCase() === normalizedOwner &&
        attendee.responseStatus === "declined"
      ) {
        return "owner_declined";
      }
    }
  }
  let hasExternal = false;
  for (const a of event.attendees) {
    if (a.resource) continue;
    if (!isExternalGuest(a, internalDomains)) continue;
    if (a.responseStatus !== "declined") {
      hasExternal = true;
      break;
    }
  }
  if (!hasExternal) return "no_external_guest";
  return "eligible";
}
