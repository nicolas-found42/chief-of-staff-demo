import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  IdentityDecision,
  OrganizationMention,
  RememberedMapping,
  TranscriptMatchCandidate,
  TranscriptMention,
} from "@chief-of-staff-demo/shared";

/** Reviewable facts about one mined transcript, kept for the queue listing. */
export interface TranscriptIdentityMeta {
  fileName: string | null;
  meetingDate: string | null;
}

/**
 * Durable state of transcript identity mining, one JSON collection per kind
 * under the Catalog's Workspace directory. Mentions, organizations and
 * candidates are derived state and are replaced wholesale on re-mining;
 * decisions are an append-only audit record and mappings are owner state,
 * so both survive re-mining (spec #117, Implementation Decision 7: this is
 * outside Person Profiles, and the Catalog is the sole writer).
 */
export class TranscriptIdentityStore {
  private readonly root: string;

  constructor(workspaceDir: string) {
    this.root = join(workspaceDir, "transcript-catalog", "identity");
  }

  readTranscriptMeta(): Record<string, TranscriptIdentityMeta> {
    return (
      (this.read(join(this.root, "transcripts.json")) as Record<
        string,
        TranscriptIdentityMeta
      > | null) ?? {}
    );
  }

  saveTranscriptMeta(transcriptId: string, meta: TranscriptIdentityMeta): void {
    const all = this.readTranscriptMeta();
    all[transcriptId] = meta;
    this.write("transcripts.json", all);
  }

  readMentions(): TranscriptMention[] {
    return this.readCollection<TranscriptMention>("mentions.json");
  }

  replaceMentions(transcriptId: string, mentions: TranscriptMention[]): void {
    this.replaceCollection<TranscriptMention>("mentions.json", (all) => ({
      ...Object.fromEntries(
        all.filter((m) => m.provenance.transcriptId !== transcriptId).map((m) => [m.id, m]),
      ),
      ...Object.fromEntries(mentions.map((m) => [m.id, m])),
    }));
  }

  readOrganizations(): OrganizationMention[] {
    return this.readCollection<OrganizationMention>("organizations.json");
  }

  replaceOrganizations(transcriptId: string, organizations: OrganizationMention[]): void {
    this.replaceCollection<OrganizationMention>("organizations.json", (all) => ({
      ...Object.fromEntries(
        all.filter((o) => o.provenance.transcriptId !== transcriptId).map((o) => [o.id, o]),
      ),
      ...Object.fromEntries(organizations.map((o) => [o.id, o])),
    }));
  }

  readCandidates(): TranscriptMatchCandidate[] {
    return this.readCollection<TranscriptMatchCandidate>("candidates.json");
  }

  replaceCandidates(transcriptId: string, candidates: TranscriptMatchCandidate[]): void {
    this.replaceCollection<TranscriptMatchCandidate>("candidates.json", (all) => ({
      ...Object.fromEntries(
        all.filter((c) => c.transcriptId !== transcriptId).map((c) => [c.id, c]),
      ),
      ...Object.fromEntries(candidates.map((c) => [c.id, c])),
    }));
  }

  /** Append-only: decisions are audit records and are never rewritten. */
  appendDecision(decision: IdentityDecision): void {
    const all = this.readDecisions();
    all.push(decision);
    this.write("decisions.json", all);
  }

  readDecisions(): IdentityDecision[] {
    return this.readCollection<IdentityDecision>("decisions.json");
  }

  /** The current decision for a mention: its latest appended record. */
  latestDecision(mentionId: string): IdentityDecision | null {
    const all = this.readDecisions().filter((d) => d.mentionId === mentionId);
    return all.at(-1) ?? null;
  }

  readMappings(): RememberedMapping[] {
    return this.readCollection<RememberedMapping>("mappings.json");
  }

  /** Upsert by id: re-pointing the same scoped name bumps the version. */
  saveMapping(mapping: RememberedMapping): void {
    const all = this.readMappings().filter((m) => m.id !== mapping.id);
    all.push(mapping);
    all.sort((left, right) => left.id.localeCompare(right.id));
    this.write("mappings.json", all);
  }

  private readCollection<T>(file: string): T[] {
    return (this.read(join(this.root, file)) as T[] | null) ?? [];
  }

  /** Replace one collection's entries for one transcript, keyed by record id. */
  private replaceCollection<T extends { id: string }>(
    file: string,
    merge: (all: T[]) => Record<string, T>,
  ): void {
    const merged = merge(this.readCollection<T>(file));
    const next = Object.values(merged);
    next.sort((left, right) => left.id.localeCompare(right.id));
    this.write(file, next);
  }

  private write(file: string, value: unknown): void {
    mkdirSync(this.root, { recursive: true });
    const path = join(this.root, file);
    const content = `${JSON.stringify(value, null, 2)}\n`;
    const staging = `${path}.tmp`;
    writeFileSync(staging, content);
    renameSync(staging, path);
  }

  private read(path: string): unknown {
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return null;
    }
  }
}
