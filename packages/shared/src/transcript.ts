import { z } from "zod";
import type { ExternalContactId } from "./person-profile.js";

/**
 * Extraction result — mirror of the routine's `routine/outbox-schema.json` v1,
 * with two adaptations for this app:
 *  - `drafts[].body` added: this app composes the draft text itself and creates
 *    the Gmail draft from it.
 *  - `sourceId` / `sourceUrl` generalized: a run id or Fireflies transcript id
 *    and any source URL, instead of Drive file id / url.
 */
export const ExtractionResultSchema = z.strictObject({
  version: z.literal(1),
  sourceId: z.string(),
  sourceFileName: z.string(),
  sourceUrl: z.string().nullable(),
  processedAt: z.string(),
  isTranscript: z.boolean(),
  skipReason: z.string().nullable(),
  summary: z.string(),
  tasks: z.array(
    z.strictObject({
      title: z.string().min(1),
      owner: z.string().optional(),
      due: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "due must be YYYY-MM-DD")
        .optional(),
      notes: z.string().optional(),
      sourceQuote: z.string().optional(),
    }),
  ),
  drafts: z.array(
    z.strictObject({
      /** Empty string when the recipient is unknown. */
      to: z.string().optional(),
      subject: z.string(),
      body: z.string(),
      reason: z.string().optional(),
    }),
  ),
});

export type ExtractionResult = z.infer<typeof ExtractionResultSchema>;
export type TaskItem = ExtractionResult["tasks"][number];
export type DraftItem = ExtractionResult["drafts"][number];

/**
 * Wire schema handed to LLM providers as the structured-output contract.
 * Identical to `ExtractionResultSchema` except every optional field is
 * required-but-nullable: OpenAI strict json_schema demands that all properties
 * appear in `required`. The normalization schema below removes those nulls in
 * the same validation pass before the pipeline trusts the payload.
 */
export const ExtractionWireSchema = z.strictObject({
  version: z.literal(1),
  sourceId: z.string(),
  sourceFileName: z.string(),
  sourceUrl: z.string().nullable(),
  processedAt: z.string(),
  isTranscript: z.boolean(),
  skipReason: z.string().nullable(),
  summary: z.string(),
  tasks: z.array(
    z.strictObject({
      title: z.string(),
      owner: z.string().nullable(),
      due: z.string().nullable(),
      notes: z.string().nullable(),
      sourceQuote: z.string().nullable(),
    }),
  ),
  drafts: z.array(
    z.strictObject({
      to: z.string(),
      subject: z.string(),
      body: z.string(),
      reason: z.string().nullable(),
    }),
  ),
});

const NormalizedWireExtractionSchema = ExtractionWireSchema.transform((wire): ExtractionResult => ({
  ...wire,
  tasks: wire.tasks.map((task) => {
    const out: ExtractionResult["tasks"][number] = { title: task.title };
    for (const key of ["owner", "due", "notes", "sourceQuote"] as const) {
      if (task[key] !== null) {
        out[key] = task[key];
      }
    }
    return out;
  }),
  drafts: wire.drafts.map((draft) => {
    const out: ExtractionResult["drafts"][number] = {
      to: draft.to,
      subject: draft.subject,
      body: draft.body,
    };
    if (draft.reason !== null) {
      out.reason = draft.reason;
    }
    return out;
  }),
}));

/**
 * The accepted reply variants, normalized as part of the one validation pass:
 * strict-provider wire values lose their null placeholders, while canonical
 * values (including hand-edited fixtures) pass through unchanged.
 */
export const NormalizedExtractionResultSchema = z.union([
  NormalizedWireExtractionSchema,
  ExtractionResultSchema,
]);

/* ==========================================================================
 * Transcript Catalog (ADR-0043, issue #125)
 *
 * Contracts for the Workspace-owned catalog that is the sole writer for
 * private transcript registration and processing. The owner reviews a
 * content-free folder inventory, grants one explicit folder-level consent,
 * and the catalog then registers one immutable normalized Transcript record
 * per source revision behind a checksummed, resumable ledger.
 * ========================================================================== */

/** The configured source folder the Catalog draws from. */
export interface TranscriptFolderRef {
  sourceSystem: "drive";
  folderId: string;
  folderName: string | null;
}

/** One folder file as the pre-consent inventory sees it: metadata only, never content. */
export interface TranscriptInventoryFile {
  externalFileId: string;
  fileName: string;
  sizeBytes: number | null;
  modifiedAt: string | null;
  /** Meeting date recovered from the file name, when it carries one. */
  meetingDate: string | null;
}

/** Policy facts the inventory must disclose before the owner consents. */
export interface TranscriptProviderExposure {
  sendsTranscriptTextToConfiguredModel: boolean;
  provider: string;
  model: string;
}

/**
 * First-run inventory preview: folder identity, file count, date range,
 * estimated scope, local retention, model/provider exposure and external-query
 * behavior — without mining any file's content.
 */
export interface TranscriptFolderInventory {
  folder: TranscriptFolderRef;
  fileCount: number;
  dateRange: { earliest: string | null; latest: string | null };
  estimatedScope: { totalBytes: number };
  localRetention: string;
  providerExposure: TranscriptProviderExposure;
  externalQueryBehavior: "none";
  files: TranscriptInventoryFile[];
}

/** Standing, folder-level authorization. Processing refuses without it. */
export interface TranscriptConsent {
  folderId: string;
  folderName: string | null;
  consentedAt: string;
}

/** The source facts one immutable Transcript was registered from. */
export interface TranscriptSourceRevision {
  sourceSystem: "drive";
  externalFileId: string;
  fileName: string;
  sourceUrl: string | null;
  /** sha256 of the raw source bytes. */
  checksum: string;
  /** 1-based per external file; a changed checksum is a new deliberate revision. */
  observedRevision: number;
  modifiedAt: string | null;
}

/** Calendar association, recorded only when it is known. */
export interface TranscriptOccurrence {
  occurrenceKey: string;
  calendarEventId: string | null;
}

/** Verified source metadata tying one diarized speaker label to stable
 * identity signals. Raw transcript text alone never verifies a handle or an
 * external contact identifier. */
export interface TranscriptSpeakerIdentityMapping {
  speakerLabel: string;
  calendarEmail: string | null;
  verifiedHandles: Record<string, string[]>;
  externalContactIds: ExternalContactId[];
}

/** One immutable normalized transcript per source revision. */
export interface TranscriptRecord {
  id: string;
  source: TranscriptSourceRevision;
  ingestedAt: string;
  extractorVersion: number;
  /** Immutable normalized UTF-8 text artifact. */
  normalizedText: string;
  meetingDate: string | null;
  occurrence: TranscriptOccurrence | null;
  /** Source-system speaker labels, in order of first appearance. */
  speakers: string[];
  /** Verified provider/Calendar identity metadata, when available. */
  speakerIdentityMappings?: TranscriptSpeakerIdentityMapping[];
}

export type TranscriptLedgerState = "pending" | "failed" | "skipped" | "processed";

/** Processing ledger: one entry per source revision, the exactly-once record. */
export interface TranscriptLedgerEntry {
  sourceSystem: "drive";
  externalFileId: string;
  fileName: string;
  observedRevision: number;
  checksum: string | null;
  state: TranscriptLedgerState;
  attempts: number;
  transcriptId: string | null;
  reason: string | null;
  updatedAt: string;
}

export interface TranscriptCatalogStatus {
  consent: TranscriptConsent | null;
  backfill: "idle" | "running" | "paused";
  pending: number;
  processed: number;
  failed: number;
  skipped: number;
  transcriptCount: number;
}

export interface TranscriptProcessingPass {
  /** Source revisions newly registered as immutable Transcript records. */
  processed: number;
  failed: number;
  skipped: number;
  /** Source revisions found already processed or deliberately skipped, untouched. */
  unchanged: number;
}

/* ==========================================================================
 * Transcript identity mining (ADR-0043, issue #126)
 *
 * Mentions, Organization Mentions, match candidates, Identity Decisions and
 * remembered mappings are Catalog-owned records: their persistence lives
 * outside Person Profiles (spec #117, Implementation Decision 7). A Mention
 * is evidence that a string occurred in context — never proof of identity —
 * and no mining path creates a Person Profile; only an explicit owner
 * decision does.
 * ========================================================================== */

export type IdentityDecisionAction =
  | "confirm"
  | "alternate-profile"
  | "create-profile"
  | "not-a-person"
  | "unresolved"
  | "remember-mapping";

export type IdentityDecisionOutcome = "linked" | "created" | "not-a-person" | "unresolved";

export type RememberedMappingScope = "transcript" | "workspace";

/** An explicit, scoped, versioned and reversible normalized-name mapping. */
export interface RememberedMapping {
  id: string;
  scope: RememberedMappingScope;
  scopeId: string | null;
  normalizedForm: string;
  surfaceText: string;
  profileId: string;
  mappingVersion: number;
  createdAt: string;
  revokedAt: string | null;
}

/** Entity classification for one preserved span. Never a guess at identity. */
export type TranscriptMentionKind =
  "person" | "organization" | "ambiguous-name" | "product" | "unknown";

export type TranscriptMentionConfidence = "high" | "medium" | "low";

/**
 * How the mentioned person relates to the meeting as observed: a source
 * speaker label, a name spoken inside another speaker's utterance
 * (attendee or not — the roster is not assumed), or a span with no speaker
 * context on its line.
 */
export type TranscriptAttendeeStatus = "speaker" | "third-person" | "unknown";

/** Where in which immutable Transcript the span was preserved from. */
export interface TranscriptMentionProvenance {
  transcriptId: string;
  /** Character offsets of the span inside the normalized transcript text. */
  spanStart: number;
  spanEnd: number;
  /** The span exactly as it occurs in the normalized text. */
  quote: string;
  /** Line timestamp, when the source line carried one. */
  timestamp: string | null;
  /** Speaker label of the line the span occurs on, when any. */
  speakerLabel: string | null;
  meetingDate: string | null;
}

export interface TranscriptMention {
  id: string;
  kind: TranscriptMentionKind;
  surfaceText: string;
  /**
   * Comparison forms derived per spec #117 (Extraction and normalization):
   * whitespace-, punctuation-, honorific- and credential-normalized
   * lowercase variants. Candidate matching compares these, never the raw
   * surface text.
   */
  normalizedForms: string[];
  /** Exact stable email identifiers observed on the span. */
  emails: string[];
  /** Canonicalized exact Profile URLs observed on the span. */
  profileUrls: string[];
  /** Handles verified by source speaker metadata, keyed by platform. */
  verifiedHandles: Record<string, string[]>;
  /** Provider-owned stable identifiers verified by source metadata. */
  externalContactIds: ExternalContactId[];
  /** Exact Calendar email tied to this source speaker label, when verified. */
  speakerCalendarEmail: string | null;
  /** Normalized organization name when the person was named in org context. */
  organizationContext: string | null;
  attendeeStatus: TranscriptAttendeeStatus;
  confidence: TranscriptMentionConfidence;
  provenance: TranscriptMentionProvenance;
  minedAt: string;
  algorithmVersion: number;
}

/**
 * One preserved organization span and its normalized identifiers (spec #117).
 * It is shared evidence, not a Profile employer string and not a new
 * top-level resource — there is no Organization Profile in v1.
 */
export interface OrganizationMention {
  id: string;
  surfaceText: string;
  normalizedName: string;
  aliases: string[];
  /** Email domains observed for the organization in the transcript. */
  domains: string[];
  externalCompanyIds: { system: string; externalId: string }[];
  /** Person-mention ids seen in organization context with this mention. */
  relatedMentionIds: string[];
  confidence: TranscriptMentionConfidence;
  provenance: TranscriptMentionProvenance;
  minedAt: string;
  algorithmVersion: number;
}

/** Spec #117 policy classes, minus "rejected": a non-person is a decision,
 *  not a Profile candidate, so no candidate record exists for one. */
export type TranscriptCandidatePolicyClass = "confirmed" | "probable" | "ambiguous";

/** One scored signal inside a candidate's explanation. */
export interface TranscriptCandidateSignal {
  signal:
    | "exact-email"
    | "exact-profile-url"
    | "verified-handle"
    | "external-contact-id"
    | "speaker-calendar-email"
    | "remembered-mapping"
    | "normalized-full-name"
    | "speaker-label"
    | "employer-hint";
  /** What was compared to what, in review-readable words. */
  explanation: string;
  matched: boolean;
  weight: number;
}

/** A conflict that blocks or weakens a candidate. */
export interface TranscriptCandidateConflict {
  kind:
    | "archived-profile"
    | "duplicate-stable-id"
    | "email-belongs-elsewhere"
    | "stable-id-belongs-elsewhere"
    | "name-email-mismatch";
  explanation: string;
  /** Hard conflicts prevent auto-linking (spec #117 policy classes). */
  hard: boolean;
}

export interface TranscriptCandidateEvidence {
  quote: string;
  spanStart: number;
  spanEnd: number;
  timestamp: string | null;
  speakerLabel: string | null;
}

/**
 * One explainable Profile candidate: every signal that was considered (with
 * its outcome and weight), every conflict, the resulting score, the lead
 * over the next-best candidate, the evidence spans, and the algorithm
 * version that produced the judgment.
 */
export interface TranscriptMatchCandidate {
  id: string;
  mentionId: string;
  transcriptId: string;
  profileId: string;
  policyClass: TranscriptCandidatePolicyClass;
  score: number;
  /** This candidate's lead over the next-best; null when it is the only one. */
  leadOverNext: number | null;
  signals: TranscriptCandidateSignal[];
  conflicts: TranscriptCandidateConflict[];
  evidence: TranscriptCandidateEvidence[];
  algorithmVersion: number;
  generatedAt: string;
}

/**
 * The durable, auditable resolution of a Transcript Mention to a Profile, a
 * rejection, or an unresolved state (spec #117 vocabulary). Policy-made
 * decisions are auto-links from non-conflicting stable identifiers or
 * replays of remembered mappings; owner decisions come from the Review queue.
 */
export interface IdentityDecision {
  id: string;
  mentionId: string;
  transcriptId: string;
  action: IdentityDecisionAction;
  outcome: IdentityDecisionOutcome;
  profileId: string | null;
  profileRevision: number | null;
  decidedBy: "policy" | "owner";
  decidedAt: string;
  note: string | null;
}

/** One Review-queue row: a mention, its explainable candidates, its decision. */
export interface TranscriptReviewItem {
  transcriptId: string;
  transcriptFileName: string | null;
  meetingDate: string | null;
  mention: TranscriptMention;
  candidates: TranscriptMatchCandidate[];
  decision: IdentityDecision | null;
  /** A remembered mapping that produced or may replay this mention's link. */
  rememberedMapping: RememberedMapping | null;
}

/** Organization review stays scoped to identity review and meeting evidence. */
export interface OrganizationReviewItem {
  transcriptId: string;
  transcriptFileName: string | null;
  organization: OrganizationMention;
  relatedPeople: { mentionId: string; surfaceText: string }[];
}

export interface TranscriptReviewQueue {
  items: TranscriptReviewItem[];
  organizations: OrganizationReviewItem[];
}
