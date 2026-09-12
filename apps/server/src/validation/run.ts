import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  CampaignGoldenScoreSchema,
  CampaignHumanJudgmentSchema,
  type CampaignGoldenScore,
  type CampaignHumanJudgment,
  type CampaignManifest,
  type CampaignReport,
  type CampaignSlot,
  type CampaignTerminalStatus,
  type ModelTimelineEntry,
  type ModelPriceEvidence,
  type OperationBudgetSnapshot,
  type SourceLifecycleGrant,
  type TranscriptRecord,
  type ValidationSlotFailure,
  type ValidationSlotOutcome,
} from "@chief-of-staff-demo/shared";
import type { ModelBudgetLedger } from "../llm/budget.js";
import type { ModelTimelineStore } from "../llm/timeline.js";
import type { CompleteJson } from "../llm/providers.js";
import { ModelBoundaryError } from "../llm/failure.js";
import {
  DebriefStageFailure,
  extractDebriefCandidates,
  type CandidateExtractionOptions,
  type DebriefExtractionRun,
} from "../modules/meeting-debrief/candidate-extraction.js";
import type { DebriefIdentityReview } from "../modules/meeting-debrief/deps.js";
import { TerminalOutcomeWriteError, writeTerminalRunOutcome } from "./artifacts.js";
import { readCampaignManifest } from "./manifest.js";
import {
  SlotOutcomeConflictError,
  decodeOutcomes,
  deriveSlotOutcome,
  finalizeCampaignOutcomes,
  slotFailureFor,
  statusForExtractionError,
} from "./outcome.js";
import { summarizeCampaign } from "./stats.js";

/**
 * Runs a frozen campaign's planned slots (#363, MWR-019/020/057).
 *
 * The runner never invents a slot and never replaces one: it executes exactly
 * the slots the manifest froze that hold no terminal outcome yet, records each
 * result once, and writes the derived report. Dispatch goes through the
 * existing extraction path with its admission, budget ledger and timeline
 * seams attached, so attempts, queue delay, processing time and cost are read
 * back from those seams rather than counted a second time here.
 */

export class SlotRootNotEmptyError extends Error {
  constructor(readonly root: string) {
    super(
      `Slot root ${root} already holds files; a cold slot never reuses another attempt's output.`,
    );
    this.name = "SlotRootNotEmptyError";
  }
}

function campaignOutcomePath(campaignDir: string): string {
  return join(campaignDir, "outcomes.jsonl");
}

function campaignReportPath(campaignDir: string): string {
  return join(campaignDir, "report.json");
}

export function readCampaignOutcomes(campaignDir: string): ValidationSlotOutcome[] {
  const path = campaignOutcomePath(campaignDir);
  if (!existsSync(path)) return [];
  return decodeOutcomes(readFileSync(path, "utf8"));
}

function appendCampaignOutcome(
  campaignDir: string,
  outcome: ValidationSlotOutcome,
): ValidationSlotOutcome {
  const recorded = readCampaignOutcomes(campaignDir);
  if (recorded.some((entry) => entry.slotId === outcome.slotId)) {
    throw new SlotOutcomeConflictError(outcome.slotId);
  }
  appendFileSync(campaignOutcomePath(campaignDir), `${JSON.stringify(outcome)}\n`);
  return outcome;
}

function readJudgmentRecords<T>(
  campaignDir: string,
  name: string,
  parse: (value: unknown) => T,
): T[] {
  const path = join(campaignDir, name);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => parse(JSON.parse(line) as unknown));
}

function readHumanJudgments(campaignDir: string): CampaignHumanJudgment[] {
  return readJudgmentRecords(campaignDir, "judgments.jsonl", (value) =>
    CampaignHumanJudgmentSchema.parse(value),
  );
}

function readGoldenScores(campaignDir: string): CampaignGoldenScore[] {
  return readJudgmentRecords(campaignDir, "golden-scores.jsonl", (value) =>
    CampaignGoldenScoreSchema.parse(value),
  );
}

/**
 * Zero-cost price evidence for a mock run. The mock provider contacts nothing
 * and is billed nothing, so a dry run must not consume the campaign allowance
 * the ledger tracks; the live provider keeps its real price table.
 */
export function mockModelPriceEvidence(models: readonly string[]): Map<string, ModelPriceEvidence> {
  const table = new Map<string, ModelPriceEvidence>();
  for (const model of models) {
    table.set(model, {
      model,
      inputDollarsPerMillion: 0,
      outputDollarsPerMillion: 0,
      /* The mock provider answers from a file and has no real capacity; the
         value only relaxes the pre-dispatch context check for this dry run. */
      contextWindowTokens: 1_000_000,
    });
  }
  return table;
}

/** One slot's measured facts, ready for the pure outcome derivation. */
interface SlotFacts {
  status: Exclude<CampaignTerminalStatus, "missing">;
  reason: string | null;
  failure?: ValidationSlotFailure | null | undefined;
  artifactPath: string | null;
  /** Dispatch start to terminal write; the runner adds the slot's own wait. */
  processingMs: number;
  attempts?: number | undefined;
  timeline: readonly ModelTimelineEntry[];
  ledger: OperationBudgetSnapshot | null;
}

export interface SlotExecutor {
  execute(slot: CampaignSlot): Promise<SlotFacts>;
}

export interface CampaignRunOptions {
  campaignDir: string;
  executor: SlotExecutor;
  concurrency?: number | undefined;
  now?: (() => Date) | undefined;
  /** Stops launching further slots; the run then closes whatever remains. */
  signal?: AbortSignal | undefined;
  onSlotSettled?:
    ((settled: { slot: CampaignSlot; outcome: ValidationSlotOutcome }) => void) | undefined;
  /** When given, unrecorded slots are closed as `missing` with this reason. */
  closeIncomplete?: { reason: string } | undefined;
}

export interface CampaignRunResult {
  manifest: CampaignManifest;
  outcomes: ValidationSlotOutcome[];
  report: CampaignReport;
}

export function prepareColdSlotRoot(root: string): void {
  mkdirSync(root, { recursive: true });
  if (readdirSync(root).length > 0) throw new SlotRootNotEmptyError(root);
}

/** The two terminal filenames one slot may hold, exactly one of which survives. */
function slotOutputFiles(
  root: string,
  transcriptFile: string,
): { outFile: string; errFile: string } {
  return {
    outFile: join(root, `${transcriptFile}.debrief.json`),
    errFile: join(root, `${transcriptFile}.error.json`),
  };
}

/**
 * The synthetic record the evaluation CLIs have always run: the transcript's
 * own text and date, no identity context and no application occurrence.
 */
export function syntheticTranscriptRecord(input: {
  fileName: string;
  text: string;
  ingestedAt: string;
}): TranscriptRecord {
  return {
    id: `eval-${input.fileName}`,
    source: {
      sourceSystem: "drive",
      externalFileId: `eval-${input.fileName}`,
      fileName: input.fileName,
      sourceUrl: null,
      checksum: createHash("sha256").update(input.text).digest("hex"),
      observedRevision: 1,
      modifiedAt: null,
    },
    ingestedAt: input.ingestedAt,
    extractorVersion: 0,
    normalizedText: input.text,
    meetingDate: input.fileName.match(/(\d{4}-\d{2}-\d{2})/)?.[1] ?? null,
    occurrence: null,
    speakers: [],
    speakerIdentityMappings: [],
    roster: [],
    meetingId: null,
    association: null,
  };
}

async function forEachOfLimit<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
      while (next < items.length) {
        const item = items[next++]!;
        await worker(item);
      }
    }),
  );
}

export async function runValidationCampaign(
  options: CampaignRunOptions,
): Promise<CampaignRunResult> {
  const now = options.now ?? (() => new Date());
  const manifest = readCampaignManifest(options.campaignDir);
  const recorded = readCampaignOutcomes(options.campaignDir);
  const recordedIds = new Set(recorded.map((outcome) => outcome.slotId));
  const open = manifest.slots.filter((slot) => !recordedIds.has(slot.slotId));
  const outcomes = [...recorded];

  await forEachOfLimit(open, options.concurrency ?? 4, async (slot) => {
    if (options.signal?.aborted) return;
    /* Total user-visible elapsed time begins when this slot's turn starts, so
       it includes waiting behind the pool's other slots; processing time is
       what the executor measured from dispatch. */
    const launchedAt = now().getTime();
    let facts: SlotFacts;
    try {
      facts = await options.executor.execute(slot);
    } catch (error) {
      const { status, reason } = statusForExtractionError(error);
      facts = { status, reason, artifactPath: null, processingMs: 0, timeline: [], ledger: null };
    }
    const outcome = deriveSlotOutcome({
      slot,
      status: facts.status,
      reason: facts.reason,
      failure: facts.failure ?? null,
      artifactPath: facts.artifactPath,
      attempts: facts.attempts,
      processingMs: facts.processingMs,
      totalMs: now().getTime() - launchedAt,
      timeline: facts.timeline,
      ledger: facts.ledger,
      recordedAt: now().toISOString(),
    });
    appendCampaignOutcome(options.campaignDir, outcome);
    outcomes.push(outcome);
    options.onSlotSettled?.({ slot, outcome });
  });

  if (options.closeIncomplete !== undefined) {
    for (const closed of finalizeCampaignOutcomes({
      slots: manifest.slots,
      outcomes,
      reason: options.closeIncomplete.reason,
      recordedAt: now().toISOString(),
    })) {
      appendCampaignOutcome(options.campaignDir, closed);
      outcomes.push(closed);
    }
  }

  const report = buildCampaignReport(options.campaignDir, now().toISOString());
  return { manifest, outcomes, report };
}

/**
 * The report as the record holds it: manifest, outcomes, Golden scores and
 * human judgments read from the campaign directory. The runner and the CLI's
 * report mode share this, so a rebuilt report is the same report.
 */
export function buildCampaignReport(campaignDir: string, generatedAt: string): CampaignReport {
  const report = summarizeCampaign({
    manifest: readCampaignManifest(campaignDir),
    outcomes: readCampaignOutcomes(campaignDir),
    goldenScores: readGoldenScores(campaignDir),
    humanJudgments: readHumanJudgments(campaignDir),
    generatedAt,
  });
  writeFileSync(campaignReportPath(campaignDir), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

export interface ExtractionSlotExecutorOptions {
  /** Resolve the frozen case to its transcript text and Golden expectations. */
  transcriptFor: (caseId: string) => { path: string; file: string };
  /** The completion seam for one model, already wired to its execution seams. */
  completeFor: (model: string) => CompleteJson;
  identity: DebriefIdentityReview;
  grantFor?: ((model: string) => SourceLifecycleGrant | null) | undefined;
  /**
   * `none` ends a slot at its first failed call or rejected answer with the
   * stage and the specific complaint recorded, instead of the application's
   * binding ladder, backoff and repair round (#363).
   */
  recovery?: "full" | "none" | undefined;
  strategy: string;
  ledger: ModelBudgetLedger;
  timeline: ModelTimelineStore;
  now?: (() => Date) | undefined;
  readFileText?: ((path: string) => string) | undefined;
  writeFile?: ((path: string, contents: string) => void) | undefined;
  removeFile?: ((path: string) => void) | undefined;
  /** The extraction call itself; injectable so the accounting can be driven without a model. */
  extract?: ((options: CandidateExtractionOptions) => Promise<DebriefExtractionRun>) | undefined;
}

/**
 * The real slot executor: the same extraction path the application host calls,
 * one cold root per slot, its calls charged to the slot's own budget operation
 * and recorded in the timeline store.
 */
export function createExtractionSlotExecutor(options: ExtractionSlotExecutorOptions): SlotExecutor {
  const now = options.now ?? (() => new Date());
  const readText = options.readFileText ?? ((path: string) => readFileSync(path, "utf8"));
  const extract = options.extract ?? extractDebriefCandidates;

  /* The test seam's own overrides, built once and spread into every write. */
  const fileSeams = {
    ...(options.writeFile !== undefined ? { writeFile: options.writeFile } : {}),
    ...(options.removeFile !== undefined ? { remove: options.removeFile } : {}),
  };
  return {
    async execute(slot: CampaignSlot): Promise<SlotFacts> {
      prepareColdSlotRoot(slot.root);
      const transcript = options.transcriptFor(slot.caseId);
      const files = slotOutputFiles(slot.root, transcript.file);
      const text = readText(transcript.path);
      options.ledger.getOrCreateOperationSnapshot(slot.operationId, null, "debrief");
      const started = now().getTime();
      const facts = (status: SlotFacts["status"], reason: string | null): SlotFacts => ({
        status,
        reason,
        artifactPath: null,
        processingMs: now().getTime() - started,
        timeline: options.timeline.getOperationTimeline(slot.operationId),
        ledger: options.ledger.getOperationSnapshot(slot.operationId),
      });
      try {
        const checked = await extract({
          record: syntheticTranscriptRecord({
            fileName: transcript.file,
            text,
            ingestedAt: now().toISOString(),
          }),
          identity: options.identity,
          complete: options.completeFor(slot.model),
          operationId: slot.operationId,
          runId: null,
          grant: options.grantFor?.(slot.model) ?? null,
          /* No checkpoint: a cold slot never replays an earlier attempt's
             accepted artifacts, which is what makes its timing a cold run. */
          retry: {
            onAttempt: () => {},
            ...(options.recovery === "none" ? { canRetry: () => false } : {}),
          },
          ...(options.recovery ? { recovery: options.recovery } : {}),
          capture: (name: string, value: unknown) => {
            writeTerminalRunOutcome({
              outFile: `${files.outFile}.candidate-${name}.json`,
              errFile: `${files.errFile}.candidate-${name}.json`,
              body: value,
              kind: "success",
              ...fileSeams,
            });
          },
        });
        try {
          writeTerminalRunOutcome({
            outFile: files.outFile,
            errFile: files.errFile,
            kind: "success",
            body: {
              model: slot.model,
              ms: now().getTime() - started,
              valid: true,
              raw: checked.extraction,
              strategy: options.strategy,
            },
            ...fileSeams,
          });
        } catch (error) {
          const reason =
            error instanceof TerminalOutcomeWriteError
              ? error.message
              : `Could not write the terminal output: ${
                  error instanceof Error ? error.message : String(error)
                }`;
          return facts("failed", reason.slice(0, 500));
        }
        return { ...facts("success", null), artifactPath: files.outFile };
      } catch (error) {
        const { status, reason } = statusForExtractionError(error);
        const failure = slotFailureFor(error);
        const diagnostic =
          error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        try {
          writeTerminalRunOutcome({
            outFile: files.outFile,
            errFile: files.errFile,
            kind: "failure",
            body: {
              model: slot.model,
              transcript: transcript.file,
              attempts: options.timeline.getOperationTimeline(slot.operationId).length,
              ms: now().getTime() - started,
              error: diagnostic.slice(0, 2000),
              /* The specific complaint, private to the slot: the stage, the
                 measured facts of a model failure, and the validator's own
                 listing of what it rejected (#363). */
              diagnostic:
                error instanceof DebriefStageFailure
                  ? {
                      stage: error.stage,
                      kind: error.kind,
                      detail: error.detail,
                      ...(error.cause instanceof ModelBoundaryError
                        ? { model: error.cause.diagnostic }
                        : {}),
                    }
                  : null,
            },
            ...fileSeams,
          });
        } catch (writeError) {
          return {
            ...facts(status, reason),
            reason: `${reason}; the terminal error file could not be written: ${
              writeError instanceof Error ? writeError.message : String(writeError)
            }`.slice(0, 500),
          };
        }
        return { ...facts(status, reason), failure, artifactPath: files.errFile };
      }
    },
  };
}
