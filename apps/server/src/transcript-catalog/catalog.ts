import { createHash } from "node:crypto";
import {
  type TranscriptConsent,
  type TranscriptFolderInventory,
  type TranscriptInventoryFile,
  type TranscriptLedgerEntry,
  type TranscriptOccurrence,
  type TranscriptProcessingPass,
  type TranscriptRecord,
  type TranscriptSourceRevision,
  type TranscriptCatalogStatus,
} from "@chief-of-staff-demo/shared";
import { isSupportedFileName, convertToText } from "../text/convert.js";
import { meetingDateFromFileName } from "../pipeline/run.js";
import { TranscriptCatalogStore } from "./store.js";

/** Bumped whenever the normalization/registration behavior changes meaning. */
export const TRANSCRIPT_CATALOG_EXTRACTOR_VERSION = 1;

/**
 * What the Catalog needs from its source folder. The production source is the
 * existing Drive intake seam; tests inject fakes. The Catalog never polls on
 * its own schedule — it processes what a pass lists, so no duplicate consumer
 * Drive poller exists.
 */
export interface TranscriptCatalogSource {
  folder(): Promise<{ folderId: string; folderName: string | null }>;
  /** Metadata only — this is what the pre-consent inventory is built from. */
  listFiles(): Promise<TranscriptSourceFileMeta[]>;
  /** Raw source bytes, or null when the file no longer exists. */
  fetch(externalFileId: string): Promise<Buffer | null>;
}

export interface TranscriptSourceFileMeta {
  externalFileId: string;
  fileName: string;
  sizeBytes: number | null;
  modifiedAt: string | null;
  sourceUrl: string | null;
  /**
   * The name under which conversion can proceed, when it differs from the
   * Drive name — e.g. a Google Doc has no extension until exported. Absent
   * means conversion uses `fileName` itself.
   */
  conversionName?: string;
}

/** Disclosed in the inventory so consent is informed before the first run. */
export interface TranscriptCatalogDisclosure {
  provider: string;
  model: string;
}

/** The identity-mining part of Transcript processing. Its implementation owns
 * the shared Person Profiles Review queue; the Catalog only supplies each
 * newly registered immutable Transcript. */
export interface TranscriptIdentityProcessor {
  process(record: TranscriptRecord): void;
  backfill(records: TranscriptRecord[]): void;
}

export interface TranscriptCatalogDeps {
  workspaceDir: string;
  source: TranscriptCatalogSource;
  disclosure: TranscriptCatalogDisclosure;
  identity: TranscriptIdentityProcessor;
  now?: () => Date;
  log?: (message: string) => void;
}

export class ConsentRequiredError extends Error {
  constructor() {
    super("Transcript Catalog processing requires explicit folder consent");
    this.name = "ConsentRequiredError";
  }
}

const LOCAL_RETENTION =
  "Full normalized transcript text is retained locally in the Workspace until " +
  "an explicit transcript deletion; nothing is stored remotely by the Catalog.";

const SPEAKER_LABEL = /^\s*([^:\n]{1,80})\s*:\s*.+/;
const PERSON_LIKE_LABEL = /^[A-Z][a-z]+(?:\s[A-Z][a-z]+)?$/;

/**
 * Source-system speaker labels, in order of first appearance. This is
 * diarization metadata for the record, not identity mining: labels are
 * evidence strings and never become identity here.
 */
function collectSpeakerLabels(text: string): string[] {
  const labels = new Set<string>();
  for (const line of text.split("\n")) {
    const match = line.match(SPEAKER_LABEL);
    if (!match) continue;
    const label = match[1]?.trim();
    if (!label) continue;
    if (
      (label.length < 40 && !label.includes(" ")) ||
      PERSON_LIKE_LABEL.test(label) ||
      /^speaker/i.test(label)
    ) {
      labels.add(label);
    }
  }
  return [...labels];
}

function checksumOf(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function dayOf(value: string | null): string | null {
  if (!value) return null;
  return value.slice(0, 10);
}

/**
 * The shared Transcript Catalog (deep interface; ADR-0043). It is the sole
 * writer for private transcript registration: consent, the processing ledger,
 * and the immutable normalized Transcript records all live behind it.
 */
export class TranscriptCatalog {
  private readonly store: TranscriptCatalogStore;
  private readonly source: TranscriptCatalogSource;
  private readonly disclosure: TranscriptCatalogDisclosure;
  private readonly identity: TranscriptIdentityProcessor;
  private readonly now: () => Date;
  private readonly log: (message: string) => void;
  /** The pass currently running, if any; a second caller awaits the same one. */
  private inFlight: Promise<TranscriptProcessingPass> | null = null;

  constructor(deps: TranscriptCatalogDeps) {
    this.store = new TranscriptCatalogStore(deps.workspaceDir);
    this.source = deps.source;
    this.disclosure = deps.disclosure;
    this.identity = deps.identity;
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? (() => {});
  }

  /**
   * First-run inventory preview. Content-free by construction: only the file
   * listing is read, never a file's bytes, so no mining happens before consent.
   */
  async inventory(): Promise<TranscriptFolderInventory> {
    const folder = await this.source.folder();
    const listed = await this.source.listFiles();
    const files: TranscriptInventoryFile[] = listed.map((file) => ({
      externalFileId: file.externalFileId,
      fileName: file.fileName,
      sizeBytes: file.sizeBytes,
      modifiedAt: file.modifiedAt,
      meetingDate: meetingDateFromFileName(file.fileName),
    }));
    const days = files
      .map((file) => dayOf(file.meetingDate) ?? dayOf(file.modifiedAt))
      .filter((day): day is string => day !== null)
      .sort();
    return {
      folder: { sourceSystem: "drive", folderId: folder.folderId, folderName: folder.folderName },
      fileCount: files.length,
      dateRange: {
        earliest: days[0] ?? null,
        latest: days[days.length - 1] ?? null,
      },
      estimatedScope: {
        totalBytes: files.reduce((total, file) => total + (file.sizeBytes ?? 0), 0),
      },
      localRetention: LOCAL_RETENTION,
      providerExposure: {
        sendsTranscriptTextToConfiguredModel: true,
        provider: this.disclosure.provider,
        model: this.disclosure.model,
      },
      externalQueryBehavior: "none",
      files,
    };
  }

  status(): TranscriptCatalogStatus {
    const ledger = this.store.readLedger();
    const count = (state: TranscriptLedgerEntry["state"]): number =>
      ledger.filter((entry) => entry.state === state).length;
    return {
      consent: this.store.readConsent(),
      backfill: this.store.readPaused() ? "paused" : this.inFlight ? "running" : "idle",
      pending: count("pending"),
      processed: count("processed"),
      failed: count("failed"),
      skipped: count("skipped"),
      transcriptCount: this.store.listTranscripts().length,
    };
  }

  /**
   * Explicit folder-level consent. Records standing consent for this folder
   * (idempotent for the same folder) and starts the full historical backfill.
   */
  async grantConsent(): Promise<void> {
    const folder = await this.source.folder();
    const existing = this.store.readConsent();
    const consent: TranscriptConsent = {
      folderId: folder.folderId,
      folderName: folder.folderName,
      consentedAt:
        existing && existing.folderId === folder.folderId
          ? existing.consentedAt
          : this.now().toISOString(),
    };
    this.store.writeConsent(consent);
    void this.startPass().catch((error: unknown) => {
      this.log(`Transcript Catalog backfill failed: ${messageOf(error)}`);
    });
  }

  /** Pause: stop starting new file processing; a running pass stops between files. */
  pause(): void {
    this.store.writePaused(true);
  }

  /** Resume a paused backfill. */
  resume(): void {
    this.store.writePaused(false);
    if (this.store.readConsent()) {
      void this.startPass().catch((error: unknown) => {
        this.log(`Transcript Catalog resume failed: ${messageOf(error)}`);
      });
    }
  }

  /** One processing pass over the folder: resumable, idempotent, exactly-once. */
  async processAvailable(): Promise<TranscriptProcessingPass> {
    if (!this.store.readConsent()) {
      throw new ConsentRequiredError();
    }
    return this.startPass();
  }

  /** Resolves once no processing pass is running. */
  async whenIdle(): Promise<void> {
    if (this.inFlight) await this.inFlight;
  }

  listTranscripts(): TranscriptRecord[] {
    return this.store.listTranscripts().sort((a, b) => a.id.localeCompare(b.id));
  }

  getTranscript(id: string): TranscriptRecord | null {
    return this.store.readTranscript(id);
  }

  /** Associate a Calendar occurrence with a Transcript, when it becomes known. */
  associateOccurrence(id: string, occurrence: TranscriptOccurrence): TranscriptRecord {
    const record = this.store.readTranscript(id);
    if (!record) {
      throw new Error(`Unknown transcript: ${id}`);
    }
    const updated: TranscriptRecord = { ...record, occurrence };
    this.store.updateTranscript(updated);
    return updated;
  }

  private startPass(): Promise<TranscriptProcessingPass> {
    if (this.inFlight) return this.inFlight;
    const pass = this.runPass();
    this.inFlight = pass;
    return pass.finally(() => {
      this.inFlight = null;
    });
  }

  private async runPass(): Promise<TranscriptProcessingPass> {
    const result: TranscriptProcessingPass = {
      processed: 0,
      failed: 0,
      skipped: 0,
      unchanged: 0,
    };
    if (this.store.readPaused()) return result;
    this.identity.backfill(this.store.listTranscripts());
    const listed = await this.source.listFiles();
    for (const file of listed) {
      if (this.store.readPaused()) break;
      const outcome = await this.processFile(file);
      result[outcome] += 1;
    }
    return result;
  }

  /**
   * Exactly-once per source revision: fetch, checksum, and consult the ledger
   * before any registration. An unchanged revision already processed or
   * deliberately skipped is left alone; a failed one is retried.
   */
  private async processFile(
    file: TranscriptSourceFileMeta,
  ): Promise<keyof TranscriptProcessingPass> {
    const latest = this.store.latestEntry(file.externalFileId);
    let bytes: Buffer | null;
    try {
      bytes = await this.source.fetch(file.externalFileId);
    } catch (error: unknown) {
      // A fetch failure is retried on the next pass. Only an already
      // registered unchecksummed attempt is updated; a processed revision is
      // never rewritten by a transient read failure.
      if (latest && latest.checksum === null) {
        this.recordEntry({
          ...latest,
          state: "failed",
          reason: messageOf(error),
          attempts: latest.attempts + 1,
        });
      } else if (!latest) {
        this.recordEntry(this.newEntry(file, null, "failed", messageOf(error)));
      } else {
        this.log(`Transcript Catalog could not fetch ${file.fileName}: ${messageOf(error)}`);
      }
      return "failed";
    }
    if (bytes === null) {
      if (latest && latest.state !== "processed") {
        this.recordEntry({
          ...latest,
          state: "skipped",
          reason: "source file no longer exists",
        });
      }
      return "skipped";
    }
    const checksum = checksumOf(bytes);
    const effectiveName = conversionNameOf(file);
    /* A skipped revision is only "unchanged" while its skip reason still
       holds: a file that came back after disappearing, or an unsupported
       name that has since become supported (Drive rename keeps the id and
       the bytes), must be retried despite standing consent. */
    const skippableAgain =
      latest?.state === "skipped" &&
      (latest.reason === "source file no longer exists" ||
        (latest.reason === "unsupported file type" && isSupportedFileName(effectiveName)));
    if (
      latest &&
      latest.checksum === checksum &&
      (latest.state === "processed" || (latest.state === "skipped" && !skippableAgain))
    ) {
      return "unchanged";
    }

    /* A failed or interrupted attempt keeps its revision: the checksummed
       content is the same source revision, so retrying never bumps it. */
    const retryOfUnchecksummed = latest !== null && latest.checksum === null;
    const sameRevision = retryOfUnchecksummed || latest?.checksum === checksum;
    if (!sameRevision && !isSupportedFileName(effectiveName)) {
      this.recordEntry(
        this.newEntry(
          file,
          checksum,
          "skipped",
          "unsupported file type",
          latest ? latest.observedRevision + 1 : 1,
        ),
      );
      return "skipped";
    }

    const entry: TranscriptLedgerEntry = {
      ...this.newEntry(file, checksum, "pending", null),
      observedRevision: latest
        ? sameRevision
          ? latest.observedRevision
          : latest.observedRevision + 1
        : 1,
      attempts: sameRevision ? latest.attempts + 1 : 1,
    };
    this.recordEntry(entry);
    try {
      const normalizedText = await convertToText(effectiveName, bytes);
      const record: TranscriptRecord = {
        id: transcriptId(file.externalFileId, entry.observedRevision),
        source: this.sourceRevision(file, entry, checksum),
        ingestedAt: this.stamp(),
        extractorVersion: TRANSCRIPT_CATALOG_EXTRACTOR_VERSION,
        normalizedText,
        meetingDate: meetingDateFromFileName(file.fileName),
        occurrence: null,
        speakers: collectSpeakerLabels(normalizedText),
      };
      this.store.saveTranscript(record);
      this.identity.process(record);
      this.recordEntry({ ...entry, state: "processed", transcriptId: record.id });
      return "processed";
    } catch (error: unknown) {
      this.recordEntry({ ...entry, state: "failed", reason: messageOf(error) });
      this.log(`Transcript Catalog failed to process ${file.fileName}: ${messageOf(error)}`);
      return "failed";
    }
  }

  private sourceRevision(
    file: TranscriptSourceFileMeta,
    entry: TranscriptLedgerEntry,
    checksum: string,
  ): TranscriptSourceRevision {
    return {
      sourceSystem: "drive",
      externalFileId: file.externalFileId,
      fileName: file.fileName,
      sourceUrl: file.sourceUrl,
      checksum,
      observedRevision: entry.observedRevision,
      modifiedAt: file.modifiedAt,
    };
  }

  /** A first ledger entry for a revision; the revision is 1 unless told otherwise. */
  private newEntry(
    file: TranscriptSourceFileMeta,
    checksum: string | null,
    state: TranscriptLedgerEntry["state"],
    reason: string | null,
    observedRevision = 1,
  ): TranscriptLedgerEntry {
    return {
      sourceSystem: "drive",
      externalFileId: file.externalFileId,
      fileName: file.fileName,
      observedRevision,
      checksum,
      state,
      attempts: 1,
      transcriptId: null,
      reason,
      updatedAt: this.stamp(),
    };
  }

  private recordEntry(entry: TranscriptLedgerEntry): void {
    this.store.saveLedgerEntry({ ...entry, updatedAt: entry.updatedAt || this.stamp() });
  }

  private stamp(): string {
    return this.now().toISOString();
  }
}

/** `drive_<externalFileId>_r<revision>` — stable per source revision. */
function transcriptId(externalFileId: string, observedRevision: number): string {
  return `drive_${externalFileId}_r${observedRevision}`;
}

/**
 * The name conversion runs under: the Drive name itself, unless the source
 * supplies a conversion name (a Google Doc has no extension until it is
 * exported — the source knows the export name, the Catalog only consumes it).
 */
function conversionNameOf(file: TranscriptSourceFileMeta): string {
  return file.conversionName ?? file.fileName;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
