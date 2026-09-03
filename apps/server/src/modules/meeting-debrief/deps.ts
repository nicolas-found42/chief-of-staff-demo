import type {
  IdentityDecision,
  OrganizationMention,
  TranscriptMention,
  TranscriptRecord,
} from "@chief-of-staff-demo/shared";

/**
 * What the Debrief consumes from the Transcript Catalog (issue #139): the
 * immutable record of the mined Transcript — its normalized text, its Calendar
 * association, its roster. The Catalog is the sole writer and the only source;
 * the Debrief never polls Drive and never converts a source of its own.
 */
export interface DebriefCatalogReader {
  getTranscript(transcriptId: string): TranscriptRecord | null;
}

/**
 * The Catalog's identity review state for one Transcript — consumed here,
 * owned by the Catalog's identity mining (spec #117, ADR-0043). The Debrief
 * reads mentions, their latest decisions, and the Organization Mentions; it
 * decides none of them.
 */
export interface DebriefIdentityReview {
  mentions: TranscriptMention[];
  /** Latest decision per mention, as the Catalog holds it. */
  decisions: IdentityDecision[];
  organizations: OrganizationMention[];
}

export interface DebriefIdentityReviewReader {
  reviewFor(transcriptId: string): DebriefIdentityReview;
}

/** Everything one extraction sees. */
export interface DebriefExtractInput {
  record: TranscriptRecord;
  identity: DebriefIdentityReview;
}

/**
 * One outward-facing Gmail draft, as the Debrief hands it over. The addresses
 * are already decided by the approval — the outward surface receives
 * recipients, never a roster to interpret.
 */
export interface DebriefDraft {
  to: string[];
  subject: string;
  body: string;
}

/**
 * The Debrief's only outward-write capability (issue #141). Terminal approval
 * is the sole transition that reaches it. Left absent — as in the
 * extraction-only harness #139 shipped — approval still completes and no
 * outward write is structurally possible, so that property stays a wiring
 * decision rather than a promise in prose.
 */
/**
 * One Google Task, as the Debrief hands it over. Only retained actions the
 * Catalog confidently resolved to the Workspace owner's own Profile reach
 * here, so a Task is never created for work that is someone else's or for an
 * owner the Catalog could not resolve.
 */
export interface DebriefTask {
  title: string;
  notes: string;
  /** ISO date the action is due, or null when the meeting stated none. */
  due: string | null;
}

export interface DebriefOutputsDeps {
  /** Creates exactly one draft and returns the provider's id for the receipt. */
  createDraft(draft: DebriefDraft): Promise<string>;
  /**
   * Creates one Task and returns the provider's id for the receipt. Optional:
   * a surface that can draft but not create Tasks writes the draft and stops,
   * which is the same shape as a Workspace that never granted Tasks scope.
   */
  createTask?: (task: DebriefTask) => Promise<string>;
  /**
   * Reads one Task's completion from Google Tasks (issue #158). Optional:
   * absent, a Task-backed item falls back to the review store's local done.
   * Null when Google no longer holds the Task — also a local-fallback case.
   */
  getTaskStatus?: (taskId: string) => Promise<{ completed: boolean } | null>;
}
