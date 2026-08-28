/** Meeting Brief Generator — Module-owned types (issue://80, ADR-0032/0033/0034). */

export const MEETING_BRIEF_MODULE_ID = "meeting-brief-generator" as const;
export const MEETING_BRIEF_MODULE_VERSION = 1 as const;

/** Fixed Stages for v1 — no dynamic names. */
export const MEETING_BRIEF_STAGES = ["snapshot", "enrich", "compose", "deliver"] as const;
export type MeetingBriefStage = (typeof MEETING_BRIEF_STAGES)[number];

export const MEETING_BRIEF_INTAKE = "calendar" as const;

/** Calendar event identity for one occurrence (per ADR-0033). */
export interface MeetingBriefFixtureEvent {
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
  }>;
  attachments?: string[];
}

/** One enrichment source artifact (per fixture boundary). */
export interface MeetingBriefEnrichmentSection {
  source: string;
  guest?: string;
  company?: string;
  status: "completed" | "empty" | "failed";
  evidence: string[];
  references: string[];
}

/** Structured Meeting Brief retained in the Run (Module-owned Result Shape). */
export interface MeetingBrief {
  version: 1;
  eventId: string;
  occurrenceId: string;
  eventVersion: string;
  generatedAt: string;
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
  }>;
  companies: Array<{
    name: string;
    domain: string | null;
    hubspotContext: string | null;
    docs: string[];
    news: string[];
    industry: string[];
    uncertainty: string[];
  }>;
  conversationStarters: string[];
  sourceReferences: string[];
  missingEvidence: string[];
  uncertainty: string[];
}

/** Delivery state retained on the Run. */
export interface MeetingBriefDeliveryState {
  status: "sent" | "superseded" | "failed" | "pending";
  sentAt: string | null;
  messageId: string | null;
  recipient: string | null;
  attempts: number;
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
}

/** GET /api/meeting-brief/index — Cross-Run index derived on read (ADR-0005). */
export interface MeetingBriefIndex {
  upcoming: MeetingBriefUpcoming[];
  briefs: MeetingBriefIndexEntry[];
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
