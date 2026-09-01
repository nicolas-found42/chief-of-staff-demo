import { extractDomain } from "./eligibility.js";

/**
 * Versioned provider bundle policy (issue://136, spec Implementation Decision
 * 18): internal and external attendees are enriched from different bundles,
 * and the classification — Internal Domain or not — selects the approved
 * versioned bundle for each attendee. Every provider a bundle selects is
 * required: a Brief is never presented as complete when configured evidence
 * is missing (spec #82).
 *
 * The confirmed-transcripts lane is not yet a selectable provider; the bundle
 * lists grow when that lane lands rather than shipping an unenforceable
 * requirement.
 */
export const MEETING_BRIEF_BUNDLES_VERSION = 1;

export type AttendeeBundleKind = "internal" | "external";

export type MeetingBriefBundleProvider =
  | "person-profile"
  | "gmail-relationship"
  | "gmail-company-domain"
  | "calendar-history"
  | "drive-workspace"
  | "crm"
  | "employer-proposal"
  | "public-intelligence";

export interface MeetingBriefAttendeeBundle {
  kind: AttendeeBundleKind;
  version: number;
  providers: readonly MeetingBriefBundleProvider[];
}

/** Internal bundle: Workspace-owned evidence only — colleague privacy keeps
 *  HubSpot, employer proposal, and public search out of internal preparation. */
const INTERNAL_BUNDLE: MeetingBriefAttendeeBundle = {
  kind: "internal",
  version: MEETING_BRIEF_BUNDLES_VERSION,
  providers: ["person-profile", "gmail-relationship", "calendar-history", "drive-workspace"],
};

/** External bundle: the full explicitly enabled enrichment collection. */
const EXTERNAL_BUNDLE: MeetingBriefAttendeeBundle = {
  kind: "external",
  version: MEETING_BRIEF_BUNDLES_VERSION,
  providers: [
    "person-profile",
    "gmail-relationship",
    "gmail-company-domain",
    "calendar-history",
    "drive-workspace",
    "crm",
    "employer-proposal",
    "public-intelligence",
  ],
};

/** Whether the email's domain is one of the configured Internal Domains
 *  (case-insensitive over both sides, after email parsing). */
function isInternalEmail(email: string, internalDomains: string[]): boolean {
  const domain = extractDomain(email);
  if (!domain) return false;
  const normalized = domain.toLowerCase();
  return internalDomains.some((candidate) => candidate.trim().toLowerCase() === normalized);
}

/** Classify one attendee's email against the configured Internal Domains. A
 *  Consumer Domain stays external (spec #117 External Guest): a personal
 *  mailbox is never company evidence. */
export function classifyAttendee(email: string, internalDomains: string[]): AttendeeBundleKind {
  return isInternalEmail(email, internalDomains) ? "internal" : "external";
}

/** The approved versioned bundle for one attendee, selected by Internal
 *  Domain classification. */
export function attendeeBundleFor(
  email: string,
  internalDomains: string[],
): MeetingBriefAttendeeBundle {
  return classifyAttendee(email, internalDomains) === "internal"
    ? INTERNAL_BUNDLE
    : EXTERNAL_BUNDLE;
}
