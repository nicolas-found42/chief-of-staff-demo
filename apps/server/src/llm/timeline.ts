import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod/v3";
import {
  type CorpusLoadReport,
  CorpusLoadReportSchema,
  type ModelTimelineEntry,
  ModelTimelineEntrySchema,
} from "@chief-of-staff-demo/shared";
import { WorkspaceIntegrityError, writeJsonVerifiedSync } from "../engine/commit.js";

const ModelTimelineLedgerDocumentSchema = z.object({
  version: z.number().int().min(1),
  entries: z.array(ModelTimelineEntrySchema),
});
type ModelTimelineLedgerDocument = z.infer<typeof ModelTimelineLedgerDocumentSchema>;

export interface OperationTimelineSummary {
  operationId: string;
  totalAttempts: number;
  totalDurationMs: number;
  totalQueueWaitMs: number;
  totalTokens: number;
  totalCostDollars: number;
  outcomes: Record<string, number>;
}

interface CorpusTranscriptMetric {
  id: string;
  estimatedTokens: number;
  candidateCount: number;
  duplicateObservations: number;
}

interface CorpusOperationMetric {
  operationId: string;
  arrivedAt: string;
  totalDurationMs: number;
  stageDurationsMs: Record<string, number>;
}

export interface GenerateCorpusLoadReportInput {
  transcripts: CorpusTranscriptMetric[];
  repairsByValidator: Record<string, number>;
  operations: CorpusOperationMetric[];
  measuredAt?: string | undefined;
}

/**
 * Reconstructable source-free timeline store (#346, MWR-028).
 * Retains wait, duration, token and cost facts for every attempt without
 * storing any raw transcript text or private quotes.
 */
export class ModelTimelineStore {
  private readonly filePath: string;
  private document: ModelTimelineLedgerDocument;

  constructor(workspaceDir: string) {
    this.filePath = join(workspaceDir, "model-timeline-ledger.json");
    this.document = this.loadOrCreate();
  }

  private loadOrCreate(): ModelTimelineLedgerDocument {
    if (!existsSync(this.filePath)) {
      return {
        version: 1,
        entries: [],
      };
    }

    try {
      const raw = readFileSync(this.filePath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      return ModelTimelineLedgerDocumentSchema.parse(parsed);
    } catch (error) {
      throw new WorkspaceIntegrityError(
        `Corrupt model timeline ledger at ${this.filePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private persist(doc: ModelTimelineLedgerDocument): void {
    writeJsonVerifiedSync(this.filePath, doc);
    this.document = doc;
  }

  record(entry: ModelTimelineEntry): void {
    const validated = ModelTimelineEntrySchema.parse(entry);
    const nextDoc: ModelTimelineLedgerDocument = {
      version: this.document.version + 1,
      entries: [...this.document.entries, validated],
    };
    this.persist(nextDoc);
  }

  getOperationTimeline(operationId: string): ModelTimelineEntry[] {
    return this.document.entries
      .filter((entry) => entry.operationId === operationId)
      .sort((a, b) => (a.enqueuedAt < b.enqueuedAt ? -1 : 1));
  }

  getRunTimeline(runId: string): ModelTimelineEntry[] {
    return this.document.entries
      .filter((entry) => entry.runId === runId)
      .sort((a, b) => (a.enqueuedAt < b.enqueuedAt ? -1 : 1));
  }

  getOperationSummary(operationId: string): OperationTimelineSummary {
    const timeline = this.getOperationTimeline(operationId);

    let totalDurationMs = 0;
    let totalQueueWaitMs = 0;
    let totalTokens = 0;
    let totalCostDollars = 0;
    const outcomes: Record<string, number> = {};

    for (const entry of timeline) {
      totalDurationMs += entry.durationMs;
      totalQueueWaitMs += entry.queueWaitMs;
      totalTokens += entry.tokens.totalTokens;
      totalCostDollars += entry.cost.dollars;
      outcomes[entry.outcome] = (outcomes[entry.outcome] ?? 0) + 1;
    }

    return {
      operationId,
      totalAttempts: timeline.length,
      totalDurationMs,
      totalQueueWaitMs,
      totalTokens,
      totalCostDollars,
      outcomes,
    };
  }
}

/**
 * Computes source-free telemetry quantifying transcript token distributions,
 * candidate density, duplicate observation rate, and validator repairs (MWR-058).
 */
export function generateCorpusLoadReport(input: GenerateCorpusLoadReportInput): CorpusLoadReport {
  const { transcripts, repairsByValidator, operations, measuredAt } = input;

  // 1. Transcript token distribution
  const tokenCounts = transcripts.map((t) => t.estimatedTokens).sort((a, b) => a - b);
  const count = tokenCounts.length;
  let minTokens = 0;
  let maxTokens = 0;
  let meanTokens = 0;
  let medianTokens = 0;

  if (count > 0) {
    minTokens = tokenCounts[0]!;
    maxTokens = tokenCounts[count - 1]!;
    const sum = tokenCounts.reduce((acc, v) => acc + v, 0);
    meanTokens = Math.round(sum / count);
    const mid = Math.floor(count / 2);
    medianTokens =
      count % 2 !== 0
        ? tokenCounts[mid]!
        : Math.round((tokenCounts[mid - 1]! + tokenCounts[mid]!) / 2);
  }

  // 2. Candidate density
  const totalCandidates = transcripts.reduce((acc, t) => acc + t.candidateCount, 0);
  const totalTranscriptTokens = tokenCounts.reduce((acc, v) => acc + v, 0);
  const candidatesPerThousandTokens =
    totalTranscriptTokens > 0 ? (totalCandidates / totalTranscriptTokens) * 1000 : 0;

  // 3. Duplicate observation rate
  const totalDuplicates = transcripts.reduce((acc, t) => acc + t.duplicateObservations, 0);
  const totalObservations = totalCandidates + totalDuplicates;
  const duplicateRate = totalObservations > 0 ? totalDuplicates / totalObservations : 0;

  const rawReport: CorpusLoadReport = {
    measuredAt: measuredAt ?? new Date().toISOString(),
    transcriptTokenDistribution: {
      count,
      minTokens,
      maxTokens,
      meanTokens,
      medianTokens,
    },
    candidateDensity: {
      totalCandidates,
      totalTranscriptTokens,
      candidatesPerThousandTokens,
    },
    duplicateObservationRate: {
      totalObservations,
      duplicateObservations: totalDuplicates,
      duplicateRate,
    },
    repairsByValidator,
    arrivalsAndDurations: operations.map((op) => ({
      operationId: op.operationId,
      arrivedAt: op.arrivedAt,
      totalDurationMs: op.totalDurationMs,
      stageDurationsMs: op.stageDurationsMs,
    })),
  };

  return CorpusLoadReportSchema.parse(rawReport);
}
