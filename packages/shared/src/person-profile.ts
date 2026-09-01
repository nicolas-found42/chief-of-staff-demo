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
  /**
   * Identity repair (ticket #121): set when this Profile was merged away. Its
   * revisions remain readable audit records; current identity lives under the
   * surviving Profile, so consumers follow this id instead.
   */
  mergedInto?: string;
  /** Append-only repair record: one entry per invalidation this Profile filed. */
  invalidations?: PersonProfileInvalidation[];
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
  /**
   * Present when the projected revision has since been invalidated (ticket
   * #121): the repair records filed against it, read from the Profile's
   * current record. A current projection of a healthy Profile omits it.
   */
  invalidations?: PersonProfileInvalidation[];
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

// ---------------------------------------------------------------------------
// Identity repair (ticket #121): factual correction, merge, and detach/split.
// Repair operations append revisions; these types carry the audited decisions
// and the invalidation marks consumers read to refresh what they hold.
// ---------------------------------------------------------------------------

/** The repair decisions that supersede past facts or attributions. */
export type PersonProfileRepairKind = "correction" | "merge" | "evidence-detached";

/**
 * One audited repair decision, filed on the Profile it invalidates. Records
 * are append-only: a record never edits history, it marks the affected
 * revision so consumers refresh what they hold from it.
 */
export interface PersonProfileInvalidation {
  id: string;
  kind: PersonProfileRepairKind;
  /** The revision whose then-current facts this record invalidates. */
  affectedRevision: number;
  occurredAt: string;
  /** The decision in the owner's words, or a generated audit line. */
  detail: string;
  /** kind "merge", filed on the merged-away Profile: the surviving Profile id. */
  mergedInto?: string;
  /** kind "merge", filed on the surviving Profile: the merged-away Profile id. */
  mergedFrom?: string;
  /** kind "evidence-detached": the evidence record that was detached. */
  evidenceId?: string;
  /** kind "evidence-detached": where the evidence was re-attributed, when it moved. */
  movedTo?: string;
  /** kind "evidence-detached": where the evidence was wrongly attributed before. */
  movedFrom?: string;
}

/** What the owner corrects on an ordinary factual repair; omitted facts are unchanged. */
export interface PersonProfileCorrectionInput {
  fullName?: string;
  primaryEmail?: string;
  role?: string;
  currentEmployer?: string;
  background?: string;
  /** Audit note recorded with the correction decision. */
  note?: string;
}

/**
 * A merge decision: `duplicateId` is merged away into the surviving Profile.
 * Facts that both Profiles state differently must be resolved explicitly.
 */
export interface PersonProfileMergeInput {
  duplicateId: string;
  /** Chosen values for conflicting facts, keyed by fact name. */
  resolutions?: Partial<
    Record<"fullName" | "primaryEmail" | "role" | "currentEmployer" | "background", string>
  >;
  /** Audit note recorded with the merge decision. */
  note?: string;
}

/** A detach/split decision: one evidence record leaves the Profile it was attributed to. */
export interface PersonProfileDetachInput {
  evidenceId: string;
  /** When set, the evidence is re-attributed to this Profile (a split). */
  toProfileId?: string;
  /** Audit note recorded with the detach decision. */
  note?: string;
}
