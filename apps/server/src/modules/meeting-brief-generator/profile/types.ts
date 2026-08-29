// Guest Profile bounded provider contract — fixed, injectable/fake (issue://87, no LinkedIn scraping).
export const GUEST_PROFILE_PROVIDER_ID = "guest-profile" as const;
export const GUEST_PROFILE_PROVIDER_NAME = "Guest Profile" as const;

type GuestProfileOutcome = "completed" | "empty" | "failed";
export type GuestProfileConfidence = "high" | "medium" | "low";
export type GuestProfileConnectionState =
  | "unconfigured"
  | "connected"
  | "unverified"
  | "rejected"
  | "unauthorized"
  | "missing_authority"
  | "unavailable";

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
