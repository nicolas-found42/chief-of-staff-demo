import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CorpusLoadReportSchema, type ModelTimelineEntry } from "@chief-of-staff-demo/shared";
import {
  ModelTimelineStore,
  generateCorpusLoadReport,
} from "../../../apps/server/src/llm/timeline.js";

describe("reconstructable timeline and corpus/load telemetry", () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "timeline-test-"));
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  it("persists source-free timeline entries across restarts and recovers them identically", () => {
    const store1 = new ModelTimelineStore(workspaceDir);

    const entry1: ModelTimelineEntry = {
      attemptId: "att_1",
      operationId: "op_1",
      runId: "run_1",
      stage: "discovery",
      enqueuedAt: "2026-09-10T12:00:00.000Z",
      admittedAt: "2026-09-10T12:00:00.050Z",
      settledAt: "2026-09-10T12:00:02.000Z",
      queueWaitMs: 50,
      durationMs: 1950,
      provider: "openrouter",
      model: "deepseek/deepseek-v4.1-flash",
      binding: "response_format",
      priority: "normal",
      outcome: "completed",
      tokens: {
        promptTokens: 2500,
        completionTokens: 300,
        totalTokens: 2800,
        estimated: false,
      },
      cost: {
        dollars: 0.000434,
        estimated: false,
        unverified: false,
      },
      failureClassification: null,
      validationOutcome: "valid",
    };

    const entry2: ModelTimelineEntry = {
      attemptId: "att_2",
      operationId: "op_1",
      runId: "run_1",
      stage: "verification",
      enqueuedAt: "2026-09-10T12:00:02.100Z",
      admittedAt: "2026-09-10T12:00:02.120Z",
      settledAt: "2026-09-10T12:00:04.500Z",
      queueWaitMs: 20,
      durationMs: 2380,
      provider: "openrouter",
      model: "deepseek/deepseek-v4.1-flash",
      binding: "response_format",
      priority: "normal",
      outcome: "completed",
      tokens: {
        promptTokens: 4000,
        completionTokens: 800,
        totalTokens: 4800,
        estimated: false,
      },
      cost: {
        dollars: 0.000784,
        estimated: false,
        unverified: false,
      },
      failureClassification: null,
      validationOutcome: "repaired",
    };

    store1.record(entry1);
    store1.record(entry2);

    // Reopen store with a fresh instance on same directory (recovery 1)
    const store2 = new ModelTimelineStore(workspaceDir);
    const opTimeline = store2.getOperationTimeline("op_1");
    expect(opTimeline).toHaveLength(2);
    expect(opTimeline[0]).toEqual(entry1);
    expect(opTimeline[1]).toEqual(entry2);

    // Reopen store again (recovery 2)
    const store3 = new ModelTimelineStore(workspaceDir);
    const summary = store3.getOperationSummary("op_1");
    expect(summary.totalDurationMs).toBe(1950 + 2380);
    expect(summary.totalQueueWaitMs).toBe(50 + 20);
    expect(summary.totalTokens).toBe(2800 + 4800);
    expect(summary.totalCostDollars).toBeCloseTo(0.000434 + 0.000784, 6);
  });

  it("generates source-free corpus and load report conforming to schema", () => {
    const report = generateCorpusLoadReport({
      transcripts: [
        { id: "t1", estimatedTokens: 2000, candidateCount: 8, duplicateObservations: 1 },
        { id: "t2", estimatedTokens: 4000, candidateCount: 15, duplicateObservations: 3 },
        { id: "t3", estimatedTokens: 6000, candidateCount: 22, duplicateObservations: 2 },
      ],
      repairsByValidator: {
        verification: 3,
        responsibility: 1,
        overview: 0,
      },
      operations: [
        {
          operationId: "op_1",
          arrivedAt: "2026-09-10T10:00:00.000Z",
          totalDurationMs: 5000,
          stageDurationsMs: { discovery: 2000, verification: 3000 },
        },
        {
          operationId: "op_2",
          arrivedAt: "2026-09-10T10:05:00.000Z",
          totalDurationMs: 6500,
          stageDurationsMs: { discovery: 2500, verification: 4000 },
        },
      ],
    });

    const parsed = CorpusLoadReportSchema.parse(report);
    expect(parsed.transcriptTokenDistribution.count).toBe(3);
    expect(parsed.transcriptTokenDistribution.minTokens).toBe(2000);
    expect(parsed.transcriptTokenDistribution.maxTokens).toBe(6000);
    expect(parsed.transcriptTokenDistribution.meanTokens).toBe(4000);
    expect(parsed.transcriptTokenDistribution.medianTokens).toBe(4000);

    // Total candidates = 45, total tokens = 12000 -> (45 / 12000) * 1000 = 3.75
    expect(parsed.candidateDensity.candidatesPerThousandTokens).toBeCloseTo(3.75, 2);

    // Total observations = (8+1) + (15+3) + (22+2) = 9 + 18 + 24 = 51. Duplicates = 6. 6/51 = 0.1176
    expect(parsed.duplicateObservationRate.duplicateObservations).toBe(6);
    expect(parsed.duplicateObservationRate.duplicateRate).toBeCloseTo(6 / 51, 3);

    expect(parsed.repairsByValidator.verification).toBe(3);
    expect(parsed.arrivalsAndDurations).toHaveLength(2);
  });
});
