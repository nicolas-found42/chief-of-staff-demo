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
