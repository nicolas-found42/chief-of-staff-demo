/** Meeting Brief Generator — Module-owned types (issue://80, ADR-0032/0033/0034). */

export const MEETING_BRIEF_MODULE_ID = "meeting-brief-generator" as const;
export const MEETING_BRIEF_MODULE_VERSION = 1 as const;

/** Fixed Stages for v1 — no dynamic names. */
export const MEETING_BRIEF_STAGES = ["snapshot", "enrich", "compose", "deliver"] as const;
export type MeetingBriefStage = (typeof MEETING_BRIEF_STAGES)[number];

export const MEETING_BRIEF_INTAKE = "calendar" as const;

export interface MeetingBriefOccurrenceIdentity {
  eventId: string;
  occurrenceId: string;
  occurrenceKey: string;
}

export function meetingBriefOccurrenceIdentity(
  eventId: string,
  occurrenceId: string,
): MeetingBriefOccurrenceIdentity {
  if (!eventId || !occurrenceId || eventId.includes("::") || occurrenceId.includes("::")) {
    throw new Error("Meeting Brief occurrence identity requires non-empty delimiter-free parts");
  }
  return { eventId, occurrenceId, occurrenceKey: `${eventId}::${occurrenceId}` };
}

export function parseMeetingBriefOccurrenceKey(
  occurrenceKey: string,
): MeetingBriefOccurrenceIdentity | null {
  const separator = occurrenceKey.indexOf("::");
  if (separator <= 0 || separator !== occurrenceKey.lastIndexOf("::")) return null;
  const eventId = occurrenceKey.slice(0, separator);
  const occurrenceId = occurrenceKey.slice(separator + 2);
  if (!occurrenceId) return null;
  return { eventId, occurrenceId, occurrenceKey };
}

/** Current Calendar truth for one meeting occurrence (per ADR-0033). */
export interface MeetingBriefEvent {
  calendarId: string;
  eventId: string;
  /** Occurrence identity — one per recurring occurrence (e.g. eventId + start). */
  occurrenceId: string;
  version: string;
  summary: string;
  description?: string;
  startAt: string;
  endAt: string;
  location?: string | null;
  conferenceLink?: string | null;
  organizer?: { email: string; displayName?: string };
  attendees: Array<{
    email: string;
    displayName?: string;
    responseStatus: "accepted" | "tentative" | "needsAction" | "declined";
    organizer?: boolean;
    resource?: boolean;
    self?: boolean;
  }>;
  status: "confirmed" | "cancelled" | "tentative";
  isAllDay?: boolean;
  attachments?: string[];
  // Unused metadata — ignored for material change detection (ADR-0033)
  colorId?: string | null;
  etag?: string | null;
  visibility?: string | null;
  transparency?: string | null;
  created?: string | null;
  updated?: string | null;
}

/** One normalized enrichment section from a provider source. */
export interface MeetingBriefEnrichmentSection {
  source: string;
  guest?: string;
  company?: string;
  status: "completed" | "empty" | "failed";
  evidence: string[];
  references: string[];
}

/** Structured Meeting Brief retained in the Run (Module-owned Result Shape). Includes deterministic logistics. */
export interface MeetingBriefLogistics {
  title: string;
  startAt: string;
  endAt: string;
  location: string | null;
  conferenceLink: string | null;
  organizer: { email: string; displayName?: string } | null;
}

export interface MeetingBrief {
  version: 1;
  eventId: string;
  occurrenceId: string;
  eventVersion: string;
  generatedAt: string;
  logistics: MeetingBriefLogistics;
  summary: string;
  guests: Array<{
    email: string;
    name: string | null;
    role: string | null;
    background: string | null;
    relationshipHistory: string[];
    crmContext: string | null;
    talkingPoints: string[];
    uncertainty: string[];
    evidenceReferences: string[];
  }>;
  companies: Array<{
    name: string;
    domain: string | null;
    hubspotContext: string | null;
    docs: string[];
    news: string[];
    industry: string[];
    uncertainty: string[];
    evidenceReferences: string[];
  }>;
  conversationStarters: string[];
  sourceReferences: string[];
  missingEvidence: string[];
  uncertainty: string[];
}

/** Delivery state retained on the Run (ADR-0034). */
export interface MeetingBriefDeliveryState {
  status: "pending" | "sent" | "reconciled" | "superseded" | "skipped" | "failed";
  sentAt: string | null;
  messageId: string | null;
  recipient: string | null;
  attempts: number;
  /** Stable idempotency key persisted before send; used to reconcile lost acks. */
  deliveryId?: string | null;
}

/** `result.json` for one Meeting Brief Run. */
export interface MeetingBriefRunResult {
  version: 1;
  eventId: string;
  occurrenceId: string;
  eventVersion: string;
  occurrenceKey: string;
  snapshotAt: string;
  enrichAt: string | null;
  composeAt: string | null;
  meetingBrief: MeetingBrief;
  delivery: MeetingBriefDeliveryState;
  supersedes?: string | null;
  /** Audit reason when Calendar current truth prevents outward delivery. */
  deliverySkippedReason?: string;
}

/** GET /api/meeting-brief/index — Cross-Run index derived on read (ADR-0005). */
export interface MeetingBriefIndex {
  upcoming: MeetingBriefUpcoming[];
  briefs: MeetingBriefIndexEntry[];
  cancellations: MeetingBriefCancellation[];
}

export interface MeetingBriefCancellation {
  occurrenceKey: string;
  eventId: string;
  occurrenceId: string;
  version: string;
  summary: string;
  cancelledAt: string;
}

export interface MeetingBriefUpcoming {
  occurrenceKey: string;
  eventId: string;
  occurrenceId: string;
  version: string;
  summary: string;
  startAt: string;
  dueAt: string;
}

export interface MeetingBriefIndexEntry {
  runId: string;
  createdAt: string;
  status: string;
  eventId: string;
  occurrenceId: string;
  occurrenceKey: string;
  eventVersion: string;
  meetingBrief: MeetingBrief | null;
  delivery: MeetingBriefDeliveryState | null;
  supersedes: string | null;
}
export const GUEST_PROFILE_PROVIDER_ID = "guest-profile" as const;
export const GUEST_PROFILE_PROVIDER_NAME = "Guest Profile" as const;

export type GuestProfileOutcome = "completed" | "empty" | "failed";
export type GuestProfileConfidence = "high" | "medium" | "low";
export type GuestProfileConnectionState =
  "unconfigured" | "connected" | "unverified" | "rejected" | "missing_authority" | "unavailable";

export interface GuestProfileArtifact {
  guestEmail: string;
  occurrenceKey: string;
  eventVersion: string;
  source: typeof GUEST_PROFILE_PROVIDER_ID;
  outcome: GuestProfileOutcome;
  identityConfidence: GuestProfileConfidence | null;
  role: string | null;
  background: string | null;
  currentEmployer: { name: string; domain: string | null; evidence: string[] } | null;
  references: string[];
  diagnostics: {
    provider: typeof GUEST_PROFILE_PROVIDER_NAME;
    endpoint: string;
    statusCode?: number;
    error?: string;
    attemptedAt: string;
    durationMs?: number;
  };
}

export interface GuestProfileStatus {
  provider: typeof GUEST_PROFILE_PROVIDER_NAME;
  endpoint: string | null;
  apiKeyHint: string;
  state: GuestProfileConnectionState;
  lastVerifiedAt: string | null;
  lastCheck?: { at: string; state: GuestProfileConnectionState; detail: string } | null;
}

export interface GuestProfileCheckResult {
  state: GuestProfileConnectionState;
  detail: string;
  checkedAt: string;
}

export function isGuestProfileEmployerMatch(artifact: GuestProfileArtifact): boolean {
  return artifact.outcome === "completed" && artifact.currentEmployer !== null;
}

// ---------------------------------------------------------------------------
// HubSpot CRM — per-user private-app token, read-only contact/company/deal
// (issue://86, Spec #80). Shell stores secret + classifies state, Module owns
// query semantics. No shared Found42 credential.
// ---------------------------------------------------------------------------

export const HUBSPOT_CONNECTION_STATES = ["unconfigured", "unverified", "connected"] as const;
export type HubSpotConnectionState = (typeof HUBSPOT_CONNECTION_STATES)[number];

export interface HubSpotStatus {
  state: HubSpotConnectionState;
  tokenHint: string;
  lastVerifiedAt: string | null;
}

/** Bounded read-only probe classification (5 states). */
export const HUBSPOT_PROBE_STATES = [
  "missing_configuration",
  "rejected",
  "missing_authority",
  "unavailable",
  "healthy",
] as const;
export type HubSpotProbeState = (typeof HUBSPOT_PROBE_STATES)[number];

export interface HubSpotSetupCheck {
  state: HubSpotProbeState;
  /** Human-readable detail for the current state. */
  detail: string;
  /** One line per checked surface (contact/company/deal) — bounded, read-only. */
  items: Array<{ label: string; ok: boolean; detail: string }>;
  checkedAt: string;
}

/** HubSpot contact as returned for an exact-email lookup. */
export interface HubSpotContact {
  id: string;
  email: string;
  properties: Record<string, string>;
  associatedCompanyIds: string[];
  associatedDealIds: string[];
}

export interface HubSpotCompany {
  id: string;
  name: string;
  domain: string | null;
  properties: Record<string, string>;
}

export interface HubSpotDeal {
  id: string;
  name: string | null;
  amount: string | null;
  stage: string | null;
  properties: Record<string, string>;
}

/** One HubSpot enrichment artifact — stable per eventVersion + guest + source. */
export interface HubSpotEnrichmentArtifact {
  /** Stable key: `${eventVersion}::${guestEmail}::${source}` or company/deal scoped. */
  key: string;
  eventVersion: string;
  guestEmail: string;
  companyId?: string | null;
  dealId?: string | null;
  source: "hubspot-contact" | "hubspot-company" | "hubspot-deal";
  status: "completed" | "empty" | "failed";
  evidence: string[];
  references: string[];
  diagnostics: {
    probeState?: HubSpotProbeState;
    httpStatus?: number | null;
    errorCode?: string | null;
    bounded: boolean;
    maxResults: number;
    stableRef: string;
    employerMatch?: boolean;
    reason?: string;
  };
  stableRef: string;
  isEmployerMatch?: boolean;
}

export const HUBSPOT_MAX_RESULTS = 10 as const;

// ---------------------------------------------------------------------------
// Google enrichment — bounded Gmail, Calendar history, Drive Docs
// (issue://85, Spec #80). Module-owned, bounded, per eventVersion+guest/company+source.
// ---------------------------------------------------------------------------

export const GOOGLE_ENRICHMENT_MAX_GMAIL_EXACT = 10 as const;
export const GOOGLE_ENRICHMENT_MAX_GMAIL_COMPANY = 10 as const;
export const GOOGLE_ENRICHMENT_MAX_CALENDAR_HISTORY = 10 as const;
export const GOOGLE_ENRICHMENT_MAX_DRIVE_DOCS = 10 as const;

export type GoogleEnrichmentSource =
  "gmail-exact" | "gmail-company-domain" | "calendar-history" | "drive-docs";

export type GoogleEnrichmentOutcome = "completed" | "empty" | "failed";

export interface GoogleEnrichmentArtifact {
  /** Stable key: `${eventVersion}::${guestEmail.toLowerCase()}::${source}::${companyDomain ?? ""}` trimmed */
  key: string;
  eventVersion: string;
  guestEmail: string;
  /** For company-domain Gmail and company Drive — null for person-level */
  companyDomain?: string | null;
  source: GoogleEnrichmentSource;
  status: GoogleEnrichmentOutcome;
  /** Untrusted evidence — treated as data, never as instructions */
  evidence: string[];
  references: string[];
  diagnostics: {
    bounded: boolean;
    maxResults: number;
    stableRef: string;
    httpStatus?: number | null;
    errorCode?: string | null;
    reason?: string;
    truncated?: boolean;
    untrusted?: boolean;
    attempts?: number;
  };
  stableRef: string;
}

export function googleEnrichmentKey(
  eventVersion: string,
  guestEmail: string,
  source: GoogleEnrichmentSource,
  companyDomain?: string | null,
): string {
  const base = `${eventVersion}::${guestEmail.toLowerCase()}::${source}`;
  if (companyDomain) return `${base}::${companyDomain.toLowerCase()}`;
  return base;
}

export const PUBLIC_INTELLIGENCE_MAX_RESULTS = 10 as const;

export type PublicIntelligenceSource = "company-news" | "industry-news" | "employer-verification";

export type PublicIntelligenceOutcome = "completed" | "empty" | "failed";

export interface PublicIntelligenceArtifact {
  /** Stable key: `${eventVersion}::${guestEmail.toLowerCase()}::${source}::${companyName ?? ""}` trimmed */
  key: string;
  eventVersion: string;
  guestEmail: string;
  companyName?: string | null;
  companyDomain?: string | null;
  source: PublicIntelligenceSource;
  status: PublicIntelligenceOutcome;
  /** Untrusted evidence — treated as data, never as instructions */
  evidence: string[];
  references: string[];
  diagnostics: {
    bounded: boolean;
    maxResults: number;
    stableRef: string;
    window?: { from: string; to: string };
    truncated?: boolean;
    httpStatus?: number | null;
    errorCode?: string | null;
    reason?: string;
    attempts?: number;
    orgs?: string[];
    untrusted?: boolean;
  };
  stableRef: string;
}

export function publicIntelligenceKey(
  eventVersion: string,
  guestEmail: string,
  source: PublicIntelligenceSource,
  companyName?: string | null,
): string {
  const base = `${eventVersion}::${guestEmail.toLowerCase()}::${source}`;
  if (companyName) return `${base}::${companyName.toLowerCase().trim()}`;
  return base;
}
