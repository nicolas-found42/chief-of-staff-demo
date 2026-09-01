import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  IdentityDecision,
  OrganizationMergeDecision,
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

interface TranscriptIdentityProcessingEntry {
  transcriptId: string;
  algorithmVersion: number;
  inputVersion: string;
  processedAt: string;
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

  readProcessingLedger(): TranscriptIdentityProcessingEntry[] {
    return this.readCollection<TranscriptIdentityProcessingEntry>("processing.json");
  }

  wasProcessed(transcriptId: string, algorithmVersion: number, inputVersion: string): boolean {
    return this.readProcessingLedger().some(
      (entry) =>
        entry.transcriptId === transcriptId &&
        entry.algorithmVersion === algorithmVersion &&
        entry.inputVersion === inputVersion,
    );
  }

  markProcessed(entry: TranscriptIdentityProcessingEntry): void {
    const all = this.readProcessingLedger().filter(
      (existing) => existing.transcriptId !== entry.transcriptId,
    );
    all.push(entry);
    all.sort((left, right) => left.transcriptId.localeCompare(right.transcriptId));
    this.write("processing.json", all);
  }

  readMentions(): TranscriptMention[] {
    return this.readCollection<TranscriptMention>("mentions.json");
  }

  replaceMentions(transcriptId: string, mentions: TranscriptMention[]): void {
    this.replaceTranscriptCollection(
      "mentions.json",
      transcriptId,
      mentions,
      (mention) => mention.provenance.transcriptId,
    );
  }

  readOrganizations(): OrganizationMention[] {
    return this.readCollection<OrganizationMention>("organizations.json");
  }

  replaceOrganizations(transcriptId: string, organizations: OrganizationMention[]): void {
    this.replaceTranscriptCollection(
      "organizations.json",
      transcriptId,
      organizations,
      (organization) => organization.provenance.transcriptId,
    );
  }

  readCandidates(): TranscriptMatchCandidate[] {
    return this.readCollection<TranscriptMatchCandidate>("candidates.json");
  }

  replaceCandidates(transcriptId: string, candidates: TranscriptMatchCandidate[]): void {
    this.replaceTranscriptCollection(
      "candidates.json",
      transcriptId,
      candidates,
      (candidate) => candidate.transcriptId,
    );
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

  /** Append-only immutable mapping versions and revocations. */
  appendMapping(mapping: RememberedMapping): void {
    const all = this.readMappings();
    if (all.some((existing) => existing.id === mapping.id)) return;
    all.push(mapping);
    all.sort(
      (left, right) =>
        left.lineageId.localeCompare(right.lineageId) || left.mappingVersion - right.mappingVersion,
    );
    this.write("mappings.json", all);
  }

  appendOrganizationDecision(decision: OrganizationMergeDecision): void {
    const all = this.readOrganizationDecisions();
    all.push(decision);
    this.write("organization-decisions.json", all);
  }

  readOrganizationDecisions(): OrganizationMergeDecision[] {
    return this.readCollection<OrganizationMergeDecision>("organization-decisions.json");
  }

  latestOrganizationDecision(organizationMentionId: string): OrganizationMergeDecision | null {
    return (
      this.readOrganizationDecisions()
        .filter((decision) => decision.sourceOrganizationMentionId === organizationMentionId)
        .at(-1) ?? null
    );
  }

  private readCollection<T>(file: string): T[] {
    return (this.read(join(this.root, file)) as T[] | null) ?? [];
  }

  private replaceTranscriptCollection<T extends { id: string }>(
    file: string,
    transcriptId: string,
    replacements: T[],
    transcriptOf: (item: T) => string,
  ): void {
    const next = [
      ...this.readCollection<T>(file).filter((item) => transcriptOf(item) !== transcriptId),
      ...replacements,
    ];
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
