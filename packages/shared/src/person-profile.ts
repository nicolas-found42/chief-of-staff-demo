export type PersonProfileMatchConfidence = "high" | "medium" | "low";
export const PERSON_PROFILE_SOURCE_ID = "person-profile" as const;
export type PersonEvidenceKind =
  "identity" | "employment" | "social-profile" | "website" | "feed" | "publication" | "mention";

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
}
