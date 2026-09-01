export type PersonProfileMatchConfidence = "high" | "medium" | "low";
export const PERSON_PROFILE_SOURCE_ID = "person-profile" as const;
export type PersonEvidenceKind =
  "identity" | "employment" | "social-profile" | "website" | "feed" | "publication" | "mention";
export const PERSON_PROFILE_PUBLIC_SAFE_PROJECTION_VERSION = 1 as const;
export const PERSON_PROFILE_MEETING_PROJECTION_VERSION = 1 as const;
export type PersonProfileProjectionPurpose = "public-safe" | "meeting";

export interface PersonIdentitySignals {
  emails: string[];
  fullNames: string[];
  handles: Record<string, string[]>;
  profileUrls: string[];
  employerHints: string[];
}

export interface PersonEvidenceClaims {
  fullName?: string;
  role?: string;
  background?: string;
  currentEmployer?: string;
}

export interface PersonEvidenceCandidate {
  source: string;
  kind: PersonEvidenceKind;
  title: string;
  summary: string;
  url: string;
  publishedAt?: string;
  identitySignals: PersonIdentitySignals;
  claims: PersonEvidenceClaims;
}

export interface PersonEvidence extends PersonEvidenceCandidate {
  id: string;
  matchConfidence: PersonProfileMatchConfidence;
  matchedSignals: string[];
  observedAt: string;
}

export interface PersonProfileSourceDiagnostic {
  source: string;
  status: "completed" | "empty" | "failed" | "unconfigured";
  detail: string;
}

export interface PersonSocialProfile {
  platform: string;
  handle: string | null;
  url: string;
}

export interface PersonPublishingFeed {
  url: string;
  title: string | null;
}

/** What explicit manual creation records: identity inputs plus optional known facts. */
export interface PersonProfileCreateInput {
  fullName?: string;
  primaryEmail?: string;
  role?: string;
  background?: string;
  currentEmployer?: string;
}

export interface PersonProfile {
  id: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  fullName: string | null;
  primaryEmail: string | null;
  emails: string[];
  handles: Record<string, string[]>;
  profileUrls: string[];
  employerHints: string[];
  role: string | null;
  background: string | null;
  currentEmployer: string | null;
  socialProfiles: PersonSocialProfile[];
  websites: string[];
  feeds: PersonPublishingFeed[];
  publications: PersonEvidence[];
  mentions: PersonEvidence[];
  evidence: PersonEvidence[];
  sourceDiagnostics: PersonProfileSourceDiagnostic[];
  /** Reversible lifecycle state: archive is ticket #122's operation, the state is the resource's. */
  archivedAt: string | null;
}

/**
 * One evidence record reduced to what a consumer may see for its purpose: the
 * provenance (which source, which URL) and the match confidence survive; the
 * raw identity signals and claims around them stay behind the interface.
 */
export interface PersonProjectedEvidence {
  id: string;
  source: string;
  kind: PersonEvidenceKind;
  title: string;
  summary: string;
  url: string;
  publishedAt?: string;
  matchConfidence: PersonProfileMatchConfidence;
  observedAt: string;
}

export interface PersonProfileProjectionBase {
  profileId: string;
  profileRevision: number;
  fullName: string | null;
  role: string | null;
  background: string | null;
  currentEmployer: string | null;
  socialProfiles: PersonSocialProfile[];
  websites: string[];
  feeds: PersonPublishingFeed[];
}

/**
 * What a content-creation consumer may hold (spec #117): public facts and
 * publishing surfaces only. Private email, CRM/contact records, search
 * diagnostics, and mention evidence are outside its authority.
 */
export interface PersonProfilePublicSafeProjection extends PersonProfileProjectionBase {
  purpose: "public-safe";
  projectionVersion: typeof PERSON_PROFILE_PUBLIC_SAFE_PROJECTION_VERSION;
  publications: PersonProjectedEvidence[];
}

/**
 * What a meeting consumer may hold: contact and evidence for preparation.
 * Enrichment plumbing (source diagnostics, signal bookkeeping) is outside its
 * authority — the owner reads diagnostics on the Profile detail surface.
 */
export interface PersonProfileMeetingProjection extends PersonProfileProjectionBase {
  purpose: "meeting";
  projectionVersion: typeof PERSON_PROFILE_MEETING_PROJECTION_VERSION;
  primaryEmail: string | null;
  emails: string[];
  publications: PersonProjectedEvidence[];
  mentions: PersonProjectedEvidence[];
  evidence: PersonProjectedEvidence[];
}

export type PersonProfileProjection =
  PersonProfilePublicSafeProjection | PersonProfileMeetingProjection;

/* ---------------------------------------------------------------------------
 * Owner onboarding (issue #123). The connected Google identity proposes the
 * Workspace owner's canonical Profile; only an explicit owner confirmation
 * pins the reference below. These types serve the onboarding namespace and
 * the /api/onboarding routes, not the Profile store itself.
 * ------------------------------------------------------------------------- */

/** What onboarding shows before any confirmation: the connected identity and
 * any existing Profile its exact email already anchors. Never a confirmation. */
export interface OwnerOnboardingProposal {
  googleEmail: string;
  matchedProfileId: string | null;
  matchedProfileRevision: number | null;
}

/** The owner reference workflows gate on: an exact Profile revision, held for
 * one Google identity. Changing or disconnecting that identity voids it. */
export interface ConfirmedOwnerReference {
  profileId: string;
  profileRevision: number;
  confirmedAt: string;
  confirmedForGoogleEmail: string;
}
