import { z } from "zod";

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
