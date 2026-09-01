import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type {
  TranscriptConsent,
  TranscriptLedgerEntry,
  TranscriptRecord,
} from "@chief-of-staff-demo/shared";

/**
 * Durable state of the Transcript Catalog: the standing folder consent, the
 * processing ledger (one entry per source revision — the exactly-once record),
 * and one immutable JSON file per Transcript record. There is no database: the
 * Workspace directory is the store, as everywhere else in the app.
 */
export class TranscriptCatalogStore {
  private readonly root: string;
  private readonly transcriptsDir: string;

  constructor(workspaceDir: string) {
    this.root = join(workspaceDir, "transcript-catalog");
    this.transcriptsDir = join(this.root, "transcripts");
  }

  readConsent(): TranscriptConsent | null {
    return this.read(join(this.root, "consent.json")) as TranscriptConsent | null;
  }

  writeConsent(consent: TranscriptConsent): void {
    mkdirSync(this.root, { recursive: true });
    this.writeAtomic(join(this.root, "consent.json"), this.serialize(consent));
  }

  /** Whether the owner paused the backfill; survives a restart. */
  readPaused(): boolean {
    const state = this.read(join(this.root, "backfill.json")) as { paused?: boolean } | null;
    return state?.paused === true;
  }

  writePaused(paused: boolean): void {
    mkdirSync(this.root, { recursive: true });
    this.writeAtomic(join(this.root, "backfill.json"), this.serialize({ paused }));
  }

  readLedger(): TranscriptLedgerEntry[] {
    const entries = this.read(join(this.root, "ledger.json")) as TranscriptLedgerEntry[] | null;
    return entries ?? [];
  }

  /**
   * Replace one entry, keyed by source revision (external file + observed
   * revision). Entries are append-or-update only; a stored entry is never
   * rewritten to forget what happened to a revision.
   */
  saveLedgerEntry(entry: TranscriptLedgerEntry): void {
    const entries = this.readLedger();
    const key = (candidate: TranscriptLedgerEntry): string =>
      `${candidate.externalFileId}#${candidate.observedRevision}`;
    const next = [...entries.filter((candidate) => key(candidate) !== key(entry)), entry];
    next.sort((a, b) => key(a).localeCompare(key(b)));
    mkdirSync(this.root, { recursive: true });
    this.writeAtomic(join(this.root, "ledger.json"), this.serialize(next));
  }

  latestEntry(externalFileId: string): TranscriptLedgerEntry | null {
    const entries = this.readLedger().filter((entry) => entry.externalFileId === externalFileId);
    if (entries.length === 0) return null;
    return entries.reduce((latest, entry) =>
      entry.observedRevision > latest.observedRevision ? entry : latest,
    );
  }

  readTranscript(id: string): TranscriptRecord | null {
    return this.read(join(this.transcriptsDir, `${id}.json`)) as TranscriptRecord | null;
  }

  /**
   * Write-once: a Transcript record is immutable, so an existing record file
   * is never rewritten — a crash between this write and its ledger update
   * replays harmlessly instead of mutating the record (a fresh ingestedAt
   * would silently rewrite history). Association metadata has its own path.
   */
  saveTranscript(record: TranscriptRecord): void {
    mkdirSync(this.transcriptsDir, { recursive: true });
    const path = join(this.transcriptsDir, `${record.id}.json`);
    if (existsSync(path)) return;
    this.writeAtomic(path, this.serialize(record));
  }

  /** Overwrite association metadata only; the artifact fields stay untouched. */
  updateTranscript(record: TranscriptRecord): void {
    mkdirSync(this.transcriptsDir, { recursive: true });
    this.writeAtomic(join(this.transcriptsDir, `${record.id}.json`), this.serialize(record));
  }

  listTranscripts(): TranscriptRecord[] {
    if (!existsSync(this.transcriptsDir)) return [];
    return readdirSync(this.transcriptsDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => this.read(join(this.transcriptsDir, name)) as TranscriptRecord | null)
      .filter((record): record is TranscriptRecord => record !== null);
  }

  private serialize(value: unknown): string {
    return `${JSON.stringify(value, null, 2)}\n`;
  }

  private read(path: string): unknown {
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return null;
    }
  }

  private writeAtomic(path: string, content: string): void {
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, content, "utf8");
    renameSync(temporary, path);
  }
}
