import { createHash } from "node:crypto";
import { parseReviewState } from "./review.js";
import type {
  ActionItemMaterializationMapping,
  MeetingDebriefRunResult,
  ExtractionContextSnapshot,
  TranscriptRecord,
} from "@chief-of-staff-demo/shared";

/**
 * Durable Debrief publication (#358, ADR-0084, the #344 resolution).
 *
 * A Debrief Run used to be finished by file presence: `result.json` existed,
 * so the Run was done. That is not the same claim. This module makes the claim
 * explicit and checkable:
 *
 * - **Operation** — reserved before any model work, so a retry, a restart or a
 *   second Run cannot re-decide the first-extraction/policy question. Written
 *   once per Run; identical bytes replay, different bytes under one identity
 *   are an integrity failure.
 * - **Revision** — the checked result bytes are immutable under
 *   `revision-r<n>.result.json`, and the manifest written last is what makes
 *   them *prepared*: checksums, versions, source lineage and the exact output
 *   mappings. A result without its manifest is not a publication.
 * - **Publication** — a pointer that names one prepared revision. Readers
 *   resolve this pointer, never "whichever result file happens to exist". A
 *   failed replacement leaves the previous pointer and its revision readable.
 * - **Completion** — the Module's own verifier reads the committed bytes back
 *   and refuses to call a Run done unless the whole chain holds. The receipt it
 *   writes is bound to the publication identity and the operation.
 *
 * All four are plain JSON artifacts inside the Run directory, written through
 * the Shell's verified rename (`ctx.writeFile`), so this adds no Workspace
 * stored format: recovery of an intact prepared revision needs no model call,
 * and damaged accepted bytes are an integrity failure rather than a quiet
 * regeneration under the old identities.
 */

/** Accepted bytes no longer say what their receipt says they say. */
export class DebriefIntegrityError extends Error {
  constructor(
    public readonly condition: string,
    detail: string,
  ) {
    super(`Debrief publication is not sound (${condition}): ${detail}`);
    this.name = "DebriefIntegrityError";
  }
}

/** There is no published revision to read, and none was claimed. */
export class DebriefUnavailableError extends Error {
  constructor(detail: string) {
    super(`Debrief publication is unavailable: ${detail}`);
    this.name = "DebriefUnavailableError";
  }
}

/** Reading a Run's artifacts. A Run handle, a Module context, a test double. */
export interface DebriefReader {
  read(name: string): string | null;
}

/** The artifact surface the reconciler needs: reads are shared with readers. */
export interface DebriefArtifactIO extends DebriefReader {
  write(name: string, text: string): void;
}

/** The sections every current-contract publication must have validated (#345). */
const DEBRIEF_REQUIRED_SECTIONS = [
  "summary",
  "decisions",
  "actionItems",
  "openQuestions",
  "effectivenessEvidence",
  "coachingAdvice",
  "suggestedRecipients",
] as const;

const OPERATION_FORMAT = "debrief-operation";
const MANIFEST_FORMAT = "debrief-revision-manifest";
const PUBLICATION_FORMAT = "debrief-publication";
const COMPLETION_FORMAT = "debrief-completion";
const FORMAT_VERSION = 1;

const OPERATION_ARTIFACT = "operation.json";
const PUBLICATION_ARTIFACT = "publication.json";
const COMPLETION_ARTIFACT = "completion.json";
const PROJECTION_ARTIFACT = "result.json";
const DEBRIEF_CONTEXT_ARTIFACT = "context-snapshot.json";

/** How the extraction's lineage question was answered when the operation was reserved. */
type DebriefExtractionClaim = "first" | "review-only" | "unknown";

/**
 * Whether this Run may be the lineage's first extraction, decided before the
 * model is asked anything and retained with the Run. `first` is the only claim
 * that can ever authorize automatic acceptance; `unknown` means no
 * collaborator could answer (an extraction-only harness, or a Workspace with
 * no policy), and never mints eligibility.
 */
export interface DebriefFirstExtractionReservation {
  claim: DebriefExtractionClaim;
  /** Why the claim is what it is, in words the timeline can show. */
  basis: string;
  reservedAt: string;
  /** The Run holding the retained first reservation this claim deferred to. */
  lineageRunId: string | null;
}

/** The policy facts in force when the operation was reserved. */
export interface DebriefPolicySnapshot {
  capturedAt: string;
  /** The configured Action Item Policy, or null when no policy surface is wired. */
  actionItemPolicy: string | null;
}

export interface DebriefOperationRecord {
  version: 1;
  format: typeof OPERATION_FORMAT;
  operationId: string;
  runId: string;
  transcriptId: string;
  reservedAt: string;
  source: {
    /** The immutable source file this lineage belongs to, across revisions. */
    externalFileId: string;
    checksum: string | null;
    observedRevision: number | null;
    extractorVersion: number;
  };
  firstExtraction: DebriefFirstExtractionReservation;
  policy: DebriefPolicySnapshot;
}

/** One checked output entry as it stands in the Workspace after materialization. */
interface DebriefOutputMappingRecord {
  entryId: string;
  materializationKey: string;
  payloadChecksum: string;
  candidateAlias: string | null;
  actionItemId: string;
  proposalRevision: number;
}

/**
 * How the manifest's output mappings were produced. `workspace`: the Run had a
 * materialization surface and every checked entry is mapped. `absent`: this Run
 * has no materialization surface at all (an extraction-only harness), declared
 * here rather than left for a reader to infer from an empty list.
 */
type DebriefMaterializationSurface = "workspace" | "absent";

interface DebriefRevisionManifest {
  version: 1;
  format: typeof MANIFEST_FORMAT;
  revisionId: string;
  revision: number;
  predecessorRevisionId: string | null;
  operationId: string;
  runId: string;
  transcriptId: string;
  preparedAt: string;
  resultArtifact: string;
  resultChecksum: string;
  contextArtifact: string;
  contextChecksum: string;
  source: DebriefOperationRecord["source"];
  materialization: {
    surface: DebriefMaterializationSurface;
    /** How many checked output entries the result carries. */
    expectedOutputCount: number;
    outputs: DebriefOutputMappingRecord[];
  };
  completeness: { required: "complete"; sections: string[] };
}

interface DebriefPublicationRecord {
  version: 1;
  format: typeof PUBLICATION_FORMAT;
  publicationId: string;
  generation: number;
  operationId: string;
  runId: string;
  revisionId: string;
  revision: number;
  manifestArtifact: string;
  manifestChecksum: string;
  publishedAt: string;
  predecessorPublicationId: string | null;
}

interface DebriefCompletionReceipt {
  version: 1;
  format: typeof COMPLETION_FORMAT;
  receiptId: string;
  runId: string;
  operationId: string;
  revisionId: string;
  publicationGeneration: number;
  manifestChecksum: string;
  completedAt: string;
}

/** What a reader gets back for one Run: a verified publication, or a legacy projection. */
export interface DebriefPublishedRead {
  result: MeetingDebriefRunResult;
  publication: DebriefPublicationRecord | null;
  manifest: DebriefRevisionManifest | null;
  receipt: DebriefCompletionReceipt | null;
  /** True only when the whole current-contract chain verified. */
  verified: boolean;
  /** A pre-#358 `result.json` with no publication behind it: readable, not proof. */
  legacy: boolean;
}

function revisionIdFor(revision: number): string {
  return `r${revision}`;
}

function revisionResultArtifact(revisionId: string): string {
  return `revision-${revisionId}.result.json`;
}

function revisionManifestArtifact(revisionId: string): string {
  return `revision-${revisionId}.manifest.json`;
}

/** The checksum an artifact is addressed by, over its exact stored bytes. */
function checksumOf(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

function parseOrThrow<T>(raw: string | null, what: string, condition: string): T | null {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new DebriefIntegrityError(condition, `${what} is not readable JSON`);
  }
}

function readVersioned<T extends { version: number; format: string }>(
  raw: string | null,
  what: string,
  format: string,
  condition: string,
): T | null {
  const parsed = parseOrThrow<T>(raw, what, condition);
  if (parsed === null) return null;
  if (parsed.format !== format || parsed.version !== FORMAT_VERSION) {
    throw new DebriefIntegrityError(
      condition,
      `${what} is ${String(parsed.format)} version ${String(parsed.version)}`,
    );
  }
  return parsed;
}

export function readOperation(io: DebriefReader): DebriefOperationRecord | null {
  return readVersioned<DebriefOperationRecord>(
    io.read(OPERATION_ARTIFACT),
    OPERATION_ARTIFACT,
    OPERATION_FORMAT,
    "unsupported-operation",
  );
}

function readPublication(io: DebriefReader): DebriefPublicationRecord | null {
  return readVersioned<DebriefPublicationRecord>(
    io.read(PUBLICATION_ARTIFACT),
    PUBLICATION_ARTIFACT,
    PUBLICATION_FORMAT,
    "unsupported-publication",
  );
}

function readCompletionReceipt(io: DebriefReader): DebriefCompletionReceipt | null {
  return readVersioned<DebriefCompletionReceipt>(
    io.read(COMPLETION_ARTIFACT),
    COMPLETION_ARTIFACT,
    COMPLETION_FORMAT,
    "unsupported-completion",
  );
}

/** Whether bytes claiming to be a Debrief result are one this build can read. */
function isDebriefResult(value: unknown): value is MeetingDebriefRunResult {
  const candidate = value as Record<string, unknown>;
  const debrief = candidate["debrief"] as Record<string, unknown> | null | undefined;
  return (
    candidate["version"] === 1 &&
    typeof candidate["transcriptId"] === "string" &&
    typeof debrief === "object" &&
    debrief !== null &&
    Array.isArray(debrief["actionItems"])
  );
}

/** The looser shape a pre-#358 `result.json` is read with: readable, not proof. */
function isLegacyResult(value: unknown): value is MeetingDebriefRunResult {
  const candidate = value as Record<string, unknown>;
  return (
    candidate["version"] === 1 &&
    typeof candidate["debrief"] === "object" &&
    candidate["debrief"] !== null
  );
}

function parseManifest(text: string, artifact: string): DebriefRevisionManifest {
  const parsed = readVersioned<DebriefRevisionManifest>(
    text,
    artifact,
    MANIFEST_FORMAT,
    "unsupported-manifest",
  );
  if (parsed === null) {
    throw new DebriefIntegrityError("missing-manifest", `${artifact} is empty`);
  }
  const completeness = parsed.completeness as { required: unknown; sections: unknown };
  if (completeness.required !== "complete" || !Array.isArray(completeness.sections)) {
    throw new DebriefIntegrityError(
      "incomplete-contract",
      `${artifact} does not declare a complete required section set`,
    );
  }
  return parsed;
}

function parseResult(text: string, artifact: string): MeetingDebriefRunResult {
  const parsed = parseOrThrow<unknown>(text, artifact, "unreadable-result");
  if (parsed === null || !isDebriefResult(parsed)) {
    throw new DebriefIntegrityError("unreadable-result", `${artifact} is not a Debrief result`);
  }
  return parsed;
}

/** Read a listed artifact and refuse it the moment its bytes disagree with the receipt. */
function verifyArtifactBytes(
  io: DebriefReader,
  artifact: string,
  expectedChecksum: string,
  condition: string,
): string {
  const text = io.read(artifact);
  if (text === null) {
    throw new DebriefIntegrityError(condition, `${artifact} is missing`);
  }
  const actual = checksumOf(text);
  if (actual !== expectedChecksum) {
    throw new DebriefIntegrityError(
      condition,
      `${artifact} is ${actual}, not the published ${expectedChecksum}`,
    );
  }
  return text;
}

/**
 * Reserve the logical operation before any inference (#344 §2). One Run has
 * one operation: a retry or a restart replays the identical record, and
 * different bytes under the same identity are refused rather than merged.
 */
function reserveOperation(
  io: DebriefArtifactIO,
  input: {
    runId: string;
    record: TranscriptRecord;
    reservedAt: string;
    firstExtraction: DebriefFirstExtractionReservation;
    policy: DebriefPolicySnapshot;
  },
): { operation: DebriefOperationRecord; outcome: "written" | "replayed" } {
  const existing = readOperation(io);
  if (existing) {
    if (existing.runId !== input.runId || existing.transcriptId !== input.record.id) {
      throw new DebriefIntegrityError(
        "operation-identity",
        `${OPERATION_ARTIFACT} belongs to ${existing.runId}/${existing.transcriptId}, not ${input.runId}/${input.record.id}`,
      );
    }
    return { operation: existing, outcome: "replayed" };
  }
  const operation: DebriefOperationRecord = {
    version: FORMAT_VERSION,
    format: OPERATION_FORMAT,
    operationId: `op-${input.runId}`,
    runId: input.runId,
    transcriptId: input.record.id,
    reservedAt: input.reservedAt,
    source: {
      externalFileId: input.record.source.externalFileId,
      checksum: input.record.source.checksum,
      observedRevision: input.record.source.observedRevision,
      extractorVersion: input.record.extractorVersion,
    },
    firstExtraction: input.firstExtraction,
    policy: input.policy,
  };
  io.write(OPERATION_ARTIFACT, `${JSON.stringify(operation, null, 2)}\n`);
  return { operation, outcome: "written" };
}

/**
 * The frozen context this Run extracted from: the first capture is the one
 * that counts, so a retry, a restart or a regeneration cannot rewrite the
 * context a later reader will judge the revision against (#356, MWR-043).
 */
function ensureContextSnapshot(io: DebriefArtifactIO, captured: ExtractionContextSnapshot): string {
  const held = io.read(DEBRIEF_CONTEXT_ARTIFACT);
  if (held !== null) return held;
  const text = `${JSON.stringify(captured, null, 2)}\n`;
  io.write(DEBRIEF_CONTEXT_ARTIFACT, text);
  return text;
}

/** One prepared revision: its manifest, the checked result, and whether it is marked. */
interface DebriefPreparedRevision {
  /** The manifest, or null when only the result bytes exist. */
  manifest: DebriefRevisionManifest | null;
  revision: number;
  resultArtifact: string;
  result: MeetingDebriefRunResult;
  /** True when only the result bytes exist: prepared up to the write that died. */
  adopted: boolean;
}

function listedRevisions(names: readonly string[], suffix: string): number[] {
  const revisions: number[] = [];
  for (const name of names) {
    const match = new RegExp(`^revision-r(\\d+)\\.${suffix}$`).exec(name);
    if (match) revisions.push(Number(match[1]));
  }
  return revisions.sort((a, b) => a - b);
}

/**
 * The newest revision this Run has prepared, if any. The manifest is the
 * marker: with one, the referenced result must match its checksum. A result
 * artifact alone is adopted as an interrupted preparation rather than
 * re-extracted, because those bytes are the checked bytes of this operation.
 */
function readPreparedRevision(
  io: DebriefReader,
  names: readonly string[],
): DebriefPreparedRevision | null {
  const manifests = listedRevisions(names, "manifest\\.json");
  if (manifests.length > 0) {
    const revision = manifests[manifests.length - 1]!;
    const artifact = revisionManifestArtifact(revisionIdFor(revision));
    const text = io.read(artifact);
    if (text === null) {
      throw new DebriefIntegrityError(
        "missing-manifest",
        `${artifact} is listed but cannot be read`,
      );
    }
    const manifest = parseManifest(text, artifact);
    if (manifest.revision !== revision || manifest.revisionId !== revisionIdFor(revision)) {
      throw new DebriefIntegrityError(
        "manifest-identity",
        `${artifact} describes ${manifest.revisionId} (revision ${manifest.revision})`,
      );
    }
    const resultText = verifyArtifactBytes(
      io,
      manifest.resultArtifact,
      manifest.resultChecksum,
      "damaged-prepared-result",
    );
    verifyArtifactBytes(
      io,
      manifest.contextArtifact,
      manifest.contextChecksum,
      "damaged-prepared-context",
    );
    return {
      manifest,
      revision,
      resultArtifact: manifest.resultArtifact,
      result: parseResult(resultText, manifest.resultArtifact),
      adopted: false,
    };
  }
  const results = listedRevisions(names, "result\\.json");
  if (results.length === 0) return null;
  if (results.length > 1) {
    throw new DebriefIntegrityError(
      "ambiguous-prepared-result",
      `${results.length} revision results exist with no manifest to choose between them`,
    );
  }
  const revision = results[0]!;
  const artifact = revisionResultArtifact(revisionIdFor(revision));
  const text = io.read(artifact);
  if (text === null) {
    throw new DebriefIntegrityError(
      "missing-prepared-result",
      `${artifact} is listed but cannot be read`,
    );
  }
  if (io.read(DEBRIEF_CONTEXT_ARTIFACT) === null) {
    throw new DebriefIntegrityError(
      "missing-prepared-context",
      `${DEBRIEF_CONTEXT_ARTIFACT} is missing beside an adopted revision`,
    );
  }
  return {
    manifest: null,
    revision,
    resultArtifact: artifact,
    result: parseResult(text, artifact),
    adopted: true,
  };
}

/**
 * Commit one revision's checked bytes. This is the write an interruption can
 * leave behind without its manifest; the reconciler adopts exactly those bytes
 * rather than asking the model for a second opinion.
 *
 * A revision that was never accepted — no manifest, never the published
 * revision — holds no standing, so a fresh attempt at that same revision
 * replaces it. Anything accepted is immutable: different bytes under one
 * accepted identity are an integrity failure, never a regeneration.
 */
function writeRevisionResult(
  io: DebriefArtifactIO,
  revision: number,
  resultText: string,
): DebriefPreparedRevision {
  const revisionId = revisionIdFor(revision);
  const resultArtifact = revisionResultArtifact(revisionId);
  const accepted =
    io.read(revisionManifestArtifact(revisionId)) !== null ||
    readPublication(io)?.revisionId === revisionId;
  const held = io.read(resultArtifact);
  if (held !== null && held !== resultText && accepted) {
    throw new DebriefIntegrityError(
      "revision-identity",
      `${resultArtifact} already holds different bytes under this accepted revision`,
    );
  }
  if (held !== resultText) io.write(resultArtifact, resultText);
  /* Freshly produced, never adopted: the bytes came from this reconciliation's
     own model call, not from a preparation an earlier one left behind. */
  return {
    manifest: null,
    revision,
    resultArtifact,
    result: parseResult(resultText, resultArtifact),
    adopted: false,
  };
}

/** The context bytes this Run extracted from, committed once and never rewritten. */
function writeRevisionContext(io: DebriefArtifactIO, contextText: string): void {
  const held = io.read(DEBRIEF_CONTEXT_ARTIFACT);
  if (held !== null) {
    if (held !== contextText) {
      throw new DebriefIntegrityError(
        "context-identity",
        `${DEBRIEF_CONTEXT_ARTIFACT} already holds different bytes than the revision was read with`,
      );
    }
    return;
  }
  io.write(DEBRIEF_CONTEXT_ARTIFACT, contextText);
}

/** Build the manifest that marks one revision prepared. */
function prepareRevision(
  io: DebriefArtifactIO,
  input: {
    revision: number;
    predecessorRevisionId: string | null;
    operation: DebriefOperationRecord;
    writtenAt: string;
    resultText: string;
    contextText: string;
    mappings: readonly ActionItemMaterializationMapping[];
    materializationSurface: DebriefMaterializationSurface;
  },
): DebriefPreparedRevision {
  const revisionId = revisionIdFor(input.revision);
  const resultArtifact = revisionResultArtifact(revisionId);
  const manifestArtifact = revisionManifestArtifact(revisionId);
  const manifestText = io.read(manifestArtifact);
  if (manifestText !== null) {
    const held = parseManifest(manifestText, manifestArtifact);
    if (held.revisionId !== revisionId || held.revision !== input.revision) {
      throw new DebriefIntegrityError(
        "manifest-identity",
        `${manifestArtifact} describes ${held.revisionId} (revision ${held.revision})`,
      );
    }
    const stored = verifyArtifactBytes(
      io,
      held.resultArtifact,
      held.resultChecksum,
      "damaged-prepared-result",
    );
    if (stored !== input.resultText) {
      throw new DebriefIntegrityError(
        "revision-identity",
        `${manifestArtifact} was prepared from different bytes than this reconciliation holds`,
      );
    }
    return {
      manifest: held,
      revision: input.revision,
      resultArtifact: held.resultArtifact,
      result: parseResult(stored, held.resultArtifact),
      adopted: false,
    };
  }
  writeRevisionResult(io, input.revision, input.resultText);
  writeRevisionContext(io, input.contextText);
  const result = parseResult(input.resultText, resultArtifact);
  const manifest: DebriefRevisionManifest = {
    version: FORMAT_VERSION,
    format: MANIFEST_FORMAT,
    revisionId,
    revision: input.revision,
    predecessorRevisionId: input.predecessorRevisionId,
    operationId: input.operation.operationId,
    runId: input.operation.runId,
    transcriptId: input.operation.transcriptId,
    preparedAt: input.writtenAt,
    resultArtifact,
    resultChecksum: checksumOf(input.resultText),
    contextArtifact: DEBRIEF_CONTEXT_ARTIFACT,
    contextChecksum: checksumOf(input.contextText),
    source: input.operation.source,
    materialization: {
      surface: input.materializationSurface,
      expectedOutputCount: result.debrief.actionItems.length,
      outputs: input.mappings
        .filter((mapping) => mapping.debriefRunId === input.operation.runId)
        .map((mapping) => ({
          entryId: mapping.outputEntryId,
          materializationKey: mapping.key,
          payloadChecksum: mapping.payloadChecksum,
          candidateAlias: mapping.candidateAlias,
          actionItemId: mapping.actionItemId,
          proposalRevision: mapping.proposalRevision,
        })),
    },
    completeness: { required: "complete", sections: [...DEBRIEF_REQUIRED_SECTIONS] },
  };
  // The manifest is the preparation marker: written last, so a revision that
  // presents one is a revision whose referenced bytes were all committed.
  io.write(manifestArtifact, `${JSON.stringify(manifest, null, 2)}\n`);
  return { manifest, revision: input.revision, resultArtifact, result, adopted: false };
}

/** Write the pointer that makes one prepared revision the published one. */
function publishRevision(
  io: DebriefArtifactIO,
  input: {
    manifest: DebriefRevisionManifest;
    manifestChecksum: string;
    publishedAt: string;
  },
): DebriefPublicationRecord {
  const previous = readPublication(io);
  if (previous) {
    if (previous.revisionId === input.manifest.revisionId) return previous;
    if (previous.revision > input.manifest.revision) {
      // Publishing an older revision over a newer one is not a publication,
      // it is a lost update dressed as one.
      throw new DebriefIntegrityError(
        "publication-regression",
        `${PUBLICATION_ARTIFACT} points at ${previous.revisionId}, not ${input.manifest.revisionId}`,
      );
    }
  }
  const publication: DebriefPublicationRecord = {
    version: FORMAT_VERSION,
    format: PUBLICATION_FORMAT,
    publicationId: `pub-${input.manifest.runId}-${input.manifest.revision}`,
    generation: (previous?.generation ?? 0) + 1,
    operationId: input.manifest.operationId,
    runId: input.manifest.runId,
    revisionId: input.manifest.revisionId,
    revision: input.manifest.revision,
    manifestArtifact: revisionManifestArtifact(input.manifest.revisionId),
    manifestChecksum: input.manifestChecksum,
    publishedAt: input.publishedAt,
    predecessorPublicationId: previous?.publicationId ?? null,
  };
  io.write(PUBLICATION_ARTIFACT, `${JSON.stringify(publication, null, 2)}\n`);
  return publication;
}

/** The published revision's bytes, or null when this Run never published one. */
function readPublishedRevision(io: DebriefReader): {
  publication: DebriefPublicationRecord;
  manifest: DebriefRevisionManifest;
  result: MeetingDebriefRunResult;
} | null {
  const publication = readPublication(io);
  if (!publication) return null;
  const text = verifyArtifactBytes(
    io,
    publication.manifestArtifact,
    publication.manifestChecksum,
    "damaged-manifest",
  );
  const manifest = parseManifest(text, publication.manifestArtifact);
  const resultText = verifyArtifactBytes(
    io,
    manifest.resultArtifact,
    manifest.resultChecksum,
    "damaged-published-result",
  );
  verifyArtifactBytes(
    io,
    manifest.contextArtifact,
    manifest.contextChecksum,
    "damaged-published-context",
  );
  return { publication, manifest, result: parseResult(resultText, manifest.resultArtifact) };
}

/**
 * Every read of a Debrief goes through here (#344 §4): the publication pointer
 * is the authority, never `result.json`'s presence. A Run with no pointer but a
 * readable `result.json` is a pre-#358 legacy publication — readable, and
 * explicitly not evidence of the current contract.
 */
export function readPublishedDebrief(io: DebriefReader): DebriefPublishedRead | null {
  const published = readPublishedRevision(io);
  if (published) {
    const receipt = readCompletionReceipt(io);
    const valid =
      receipt !== null &&
      receipt.runId === published.publication.runId &&
      receipt.revisionId === published.publication.revisionId &&
      receipt.publicationGeneration === published.publication.generation &&
      receipt.manifestChecksum === published.publication.manifestChecksum;
    return {
      result: published.result,
      publication: published.publication,
      manifest: published.manifest,
      receipt: valid ? receipt : null,
      verified: true,
      legacy: false,
    };
  }
  const legacyRaw = io.read(PROJECTION_ARTIFACT);
  if (legacyRaw === null) return null;
  let legacy: unknown;
  try {
    legacy = JSON.parse(legacyRaw);
  } catch {
    return null;
  }
  if (!isLegacyResult(legacy)) return null;
  return {
    result: legacy,
    publication: null,
    manifest: null,
    receipt: null,
    verified: false,
    legacy: true,
  };
}

/** Every reason one prepared revision does not add up to a completable publication. */
function preparedFailures(io: DebriefReader, manifest: DebriefRevisionManifest): string[] {
  const failures: string[] = [];
  const resultText = io.read(manifest.resultArtifact);
  if (resultText === null) {
    failures.push("missing-result");
  } else if (checksumOf(resultText) !== manifest.resultChecksum) {
    failures.push("result-checksum");
  }
  const contextText = io.read(manifest.contextArtifact);
  if (contextText === null) failures.push("missing-context");
  else if (checksumOf(contextText) !== manifest.contextChecksum) failures.push("context-checksum");

  const operation = readOperation(io);
  if (!operation) failures.push("missing-operation");
  else if (operation.operationId !== manifest.operationId) failures.push("operation-identity");

  const review = io.read("review.json");
  if (review === null) failures.push("missing-review");
  else if (parseReviewState(review) === null) failures.push("unreadable-review");

  // `required` was validated when the manifest was parsed: a stored manifest
  // that does not declare the complete contract never becomes one of these.
  for (const section of DEBRIEF_REQUIRED_SECTIONS) {
    if (!manifest.completeness.sections.includes(section))
      failures.push(`missing-section:${section}`);
  }

  const outputs = manifest.materialization.outputs;
  if (manifest.materialization.surface === "workspace") {
    // No silently dropped output: the checked entries are counted, and every
    // one of them has exactly one mapping.
    if (outputs.length !== manifest.materialization.expectedOutputCount) {
      failures.push("output-mapping-count");
    }
  } else if (outputs.length !== 0) {
    failures.push("undeclared-mappings");
  }
  const keys = new Set<string>();
  for (const output of outputs) {
    if (keys.has(output.materializationKey)) failures.push(`duplicate-mapping:${output.entryId}`);
    keys.add(output.materializationKey);
    if (!output.materializationKey.endsWith(`:${output.entryId}`)) {
      failures.push(`mapping-key:${output.entryId}`);
    }
    if (output.actionItemId === "") failures.push(`mapping-record:${output.entryId}`);
  }
  return failures;
}

/**
 * Every reason the committed bytes do not add up to a *completed* publication.
 * The receipt is part of the answer: a Run whose pointer verifies but whose
 * completion record is missing or stale has unfinished commit metadata, and
 * that is exactly what recovery is for.
 */
export function completionFailures(io: DebriefReader, input: { runId: string }): string[] {
  const failures = publicationFailures(io, input);
  const publication = readPublication(io);
  if (!publication) return failures;
  const receipt = readCompletionReceipt(io);
  if (receipt === null) failures.push("missing-completion");
  else if (
    receipt.runId !== publication.runId ||
    receipt.revisionId !== publication.revisionId ||
    receipt.publicationGeneration !== publication.generation ||
    receipt.manifestChecksum !== publication.manifestChecksum
  ) {
    failures.push("stale-completion");
  }
  return failures;
}

/** The publication itself, judged without its completion receipt. */
function publicationFailures(io: DebriefReader, input: { runId: string }): string[] {
  const publication = readPublication(io);
  if (!publication) return ["no-published-revision"];
  if (publication.runId !== input.runId) return ["publication-belongs-to-another-run"];

  const manifestText = io.read(publication.manifestArtifact);
  if (manifestText === null) return ["missing-manifest"];
  if (checksumOf(manifestText) !== publication.manifestChecksum) return ["manifest-checksum"];
  const manifest = parseManifest(manifestText, publication.manifestArtifact);
  const failures: string[] = [];
  if (
    manifest.revisionId !== publication.revisionId ||
    manifest.revision !== publication.revision
  ) {
    failures.push("manifest-revision");
  }
  if (manifest.operationId !== publication.operationId) failures.push("manifest-operation");
  const resultText = io.read(manifest.resultArtifact);
  // The projection is how every pre-#358 reader (the Runs detail, the Meeting
  // and Weekly views) still finds a Debrief. It is repaired by reconciliation,
  // never assumed.
  if (resultText !== null && io.read(PROJECTION_ARTIFACT) !== resultText) {
    failures.push("result-projection");
  }
  return failures.concat(preparedFailures(io, manifest));
}

/** The receipt one completed publication carries; derived, so a replay is identical. */
function receiptFor(
  publication: DebriefPublicationRecord,
  completedAt: string,
): DebriefCompletionReceipt {
  return {
    version: FORMAT_VERSION,
    format: COMPLETION_FORMAT,
    receiptId: `receipt-${createHash("sha256")
      .update(`${publication.runId}|${publication.revisionId}|${publication.generation}`)
      .digest("hex")
      .slice(0, 16)}`,
    runId: publication.runId,
    operationId: publication.operationId,
    revisionId: publication.revisionId,
    publicationGeneration: publication.generation,
    manifestChecksum: publication.manifestChecksum,
    completedAt,
  };
}

/**
 * The Module's own completion verification (#344 §4): read the committed chain
 * back, and only then allow the Run to report done. Anything it refuses is a
 * condition a person can act on, never a silent success.
 */
function verifyCompletion(
  io: DebriefArtifactIO,
  input: { runId: string; at: string },
): DebriefCompletionReceipt {
  const failures = publicationFailures(io, input);
  if (failures.length > 0) {
    throw new DebriefIntegrityError(failures[0]!, failures.join(", "));
  }
  const publication = readPublication(io)!;
  const receipt = receiptFor(publication, input.at);
  const held = readCompletionReceipt(io);
  const fresh =
    held !== null &&
    held.runId === receipt.runId &&
    held.revisionId === receipt.revisionId &&
    held.publicationGeneration === receipt.publicationGeneration &&
    held.manifestChecksum === receipt.manifestChecksum;
  if (fresh) return held;
  io.write(COMPLETION_ARTIFACT, `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

/** Everything one reconciliation needs. The Module supplies it; this file owns the order. */
export interface DebriefReconcileInput {
  io: DebriefArtifactIO;
  /** The Run's artifact names, without touching their contents. */
  names: () => readonly string[];
  runId: string;
  record: TranscriptRecord;
  context: ExtractionContextSnapshot;
  /** Checked before any inference: the lineage/policy reservation. */
  firstExtraction: DebriefFirstExtractionReservation;
  policy: DebriefPolicySnapshot;
  /**
   * Why this Run is being reconciled. `regenerate` is the owner asking for a
   * new revision, so an existing publication does not satisfy it; `publish`
   * accepts whatever is already complete.
   */
  intent: "publish" | "regenerate";
  now: () => Date;
  /** Runs the model. Called only when no intact prepared revision exists. */
  produce: () => Promise<string>;
  /** Re-materializes exact mappings for a revision (idempotent by key). */
  materialize: (
    result: MeetingDebriefRunResult,
  ) => readonly ActionItemMaterializationMapping[] | void;
  /** Whether the Run has a materialization surface at all. */
  hasMaterializationSurface: boolean;
  /** Ensure the review record exists; never resets one that does. */
  ensureReview: () => void;
  event: (type: string, detail?: Record<string, unknown>) => void;
}

export interface DebriefReconcileOutcome {
  result: MeetingDebriefRunResult;
  publication: DebriefPublicationRecord;
  receipt: DebriefCompletionReceipt;
  /**
   * How far the reconciler had to go: `published` verified an existing
   * publication, `recovered` finished bytes an interrupted commit left behind,
   * `prepared` finalized a revision that had its manifest but no receipt, and
   * `extracted` is the only outcome that asked the model.
   */
  reconciled: "published" | "recovered" | "prepared" | "extracted";
  modelCalls: number;
}

/**
 * The one reconciler (#344 §4). Normal extraction, restart recovery, manual
 * retry, regeneration and the failed/done recovery sweep all enter here, and
 * the same decisions follow:
 *
 * 1. Reserve the operation — before any model work.
 * 2. A newer intact prepared revision wins and is finalized with zero model
 *    calls; an already-published revision is verified, not re-derived.
 * 3. Damaged accepted bytes stop the Run with an integrity failure; they are
 *    never re-extracted under the old identities.
 * 4. Otherwise the model produces exactly one revision.
 * 5. Materialize exact mappings, keep the review state, publish the pointer,
 *    verify completion and only then report done.
 */
export async function reconcileDebrief(
  input: DebriefReconcileInput,
): Promise<DebriefReconcileOutcome> {
  const reserved = reserveOperation(input.io, {
    runId: input.runId,
    record: input.record,
    reservedAt: input.now().toISOString(),
    firstExtraction: input.firstExtraction,
    policy: input.policy,
  });
  input.event("debrief_operation_reserved", {
    operationId: reserved.operation.operationId,
    outcome: reserved.outcome,
    firstExtraction: input.firstExtraction.claim,
    basis: input.firstExtraction.basis,
  });

  const contextText = ensureContextSnapshot(input.io, input.context);
  const published = readPublishedRevision(input.io);
  const prepared = readPreparedRevision(input.io, input.names());
  const newestPrepared =
    prepared && (!published || prepared.revision > published.publication.revision)
      ? prepared
      : null;

  let revision: DebriefPreparedRevision;
  let reconciled: DebriefReconcileOutcome["reconciled"];
  let modelCalls = 0;
  if (newestPrepared) {
    revision = newestPrepared;
    reconciled = newestPrepared.adopted ? "recovered" : "prepared";
    input.event("debrief_revision_recovered", {
      revisionId: revisionIdFor(revision.revision),
      adopted: newestPrepared.adopted,
    });
  } else if (published && input.intent === "publish") {
    revision = {
      manifest: published.manifest,
      revision: published.publication.revision,
      resultArtifact: published.manifest.resultArtifact,
      result: published.result,
      adopted: false,
    };
    reconciled = "published";
    input.event("debrief_publication_verified", {
      revisionId: published.publication.revisionId,
      generation: published.publication.generation,
    });
  } else {
    const produced = await input.produce();
    modelCalls = 1;
    /* The checked bytes are committed first and the manifest last, so an
       interruption between the two leaves a result this reconciler adopts
       instead of asking the model a second time. */
    const target = (published?.publication.revision ?? 0) + 1;
    revision = writeRevisionResult(input.io, target, produced);
    reconciled = "extracted";
    input.event("debrief_revision_written", { revisionId: revisionIdFor(target) });
  }

  let manifest = revision.manifest;
  if (reconciled !== "published") {
    const materialized = input.materialize(revision.result) ?? [];
    const previous = revision.manifest;
    if (previous) {
      /* The manifest is immutable, so a returned mapping that disagrees with
         it means the record it names is not the record that was accepted. */
      const byKey = new Map(materialized.map((mapping) => [mapping.key, mapping.actionItemId]));
      for (const output of previous.materialization.outputs) {
        const now = byKey.get(output.materializationKey);
        if (now !== undefined && now !== output.actionItemId) {
          throw new DebriefIntegrityError(
            "mapping-drift",
            `${output.entryId} was accepted as ${output.actionItemId} and now materializes as ${now}`,
          );
        }
      }
    }
    input.ensureReview();
    manifest = prepareRevision(input.io, {
      revision: revision.revision,
      predecessorRevisionId:
        previous?.predecessorRevisionId ?? published?.publication.revisionId ?? null,
      operation: reserved.operation,
      writtenAt: input.now().toISOString(),
      resultText: input.io.read(revision.resultArtifact)!,
      contextText,
      mappings: materialized,
      materializationSurface: input.hasMaterializationSurface ? "workspace" : "absent",
    }).manifest;
    // Verified before the pointer exists: an incomplete revision is a failed
    // Run, never a published revision that only completion would have refused.
    const failures = preparedFailures(input.io, manifest!);
    if (failures.length > 0) {
      throw new DebriefIntegrityError(failures[0]!, failures.join(", "));
    }
    input.event("debrief_revision_prepared", {
      revisionId: manifest!.revisionId,
      outputs: manifest!.materialization.outputs.length,
    });
  }

  const publication = publishRevision(input.io, {
    manifest: manifest!,
    manifestChecksum: checksumOf(input.io.read(revisionManifestArtifact(manifest!.revisionId))!),
    publishedAt: input.now().toISOString(),
  });
  // The projection is written after the pointer: nothing reads it to learn
  // whether a publication happened, and an interrupted projection is a missing
  // projection the next reconciliation repairs.
  const resultText = input.io.read(revision.resultArtifact)!;
  if (input.io.read(PROJECTION_ARTIFACT) !== resultText) {
    input.io.write(PROJECTION_ARTIFACT, resultText);
  }
  const receipt = verifyCompletion(input.io, {
    runId: input.runId,
    at: input.now().toISOString(),
  });
  input.event("debrief_published", {
    revisionId: publication.revisionId,
    generation: publication.generation,
    outputs: manifest!.materialization.outputs.length,
  });
  input.event("debrief_completion_verified", {
    receiptId: receipt.receiptId,
    revisionId: receipt.revisionId,
  });
  return { result: revision.result, publication, receipt, reconciled, modelCalls };
}
