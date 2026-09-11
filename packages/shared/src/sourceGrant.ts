export interface TranscriptRoutePolicy {
  /**
   * Whether Zero Data Retention is required for this route (#341, ADR-0081).
   * Models that do not support ZDR are refused unless an explicit exception is granted.
   */
  zdrRequired: boolean;
  /**
   * Data collection policy for the provider. Defaults to "deny" to forbid model training.
   */
  dataCollection: "deny" | "allow";
  /**
   * Explicit owner-approved non-ZDR exception (#341).
   * Used for models like nex-agi/nex-n2.5-mini:free where the owner explicitly accepted
   * 30-day retention with no-training.
   */
  allowNonZdrException?: boolean;
  /**
   * Bounded set of approved endpoint tags or hosts.
   */
  allowedEndpoints?: string[];
}

export interface SourceLifecycleGrant {
  id: string;
  sourceId: string;
  purpose: "meeting-debrief" | "meeting-brief" | "validation-campaign";
  grantedBy: string;
  grantedAt: string;
  revokedAt: string | null;
  routePolicy: TranscriptRoutePolicy;
}
