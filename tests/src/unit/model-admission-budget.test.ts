import { describe, expect, it } from "vitest";
import {
  AdmissionOutcomeSchema,
  CAMPAIGN_BUDGET_DOLLARS_DEFAULT,
  CampaignBudgetSnapshotSchema,
  CorpusLoadReportSchema,
  DEBRIEF_OPERATION_BUDGET_DOLLARS_DEFAULT,
  ModelAdmissionConfigSchema,
  ModelAdmissionPrioritySchema,
  ModelPriceEvidenceSchema,
  ModelTimelineEntrySchema,
  OPERATION_INPUT_TOKEN_CEILING_DEFAULT,
  OPERATION_OUTPUT_TOKEN_CEILING_DEFAULT,
  OperationBudgetSnapshotSchema,
  TokenReservationEstimateSchema,
  defaultModelPriceEvidence,
  estimateConservativeTokens,
} from "@chief-of-staff-demo/shared";

describe("model admission and budget schemas", () => {
  it("validates default admission config values", () => {
    const parsed = ModelAdmissionConfigSchema.parse({});
    expect(parsed.maxActiveAttempts).toBe(4);
    expect(parsed.starvationThresholdConsecutive).toBe(3);
    expect(parsed.agedNormalThresholdMs).toBe(60_000);
    expect(parsed.queueAgeLimitMs).toBe(30 * 60_000);
    expect(parsed.processingDeadlineMs).toBe(15 * 60_000);
  });

  it("validates priority and outcome schemas", () => {
    expect(ModelAdmissionPrioritySchema.parse("time-sensitive")).toBe("time-sensitive");
    expect(ModelAdmissionPrioritySchema.parse("normal")).toBe("normal");
    expect(() => ModelAdmissionPrioritySchema.parse("invalid")).toThrow();

    expect(AdmissionOutcomeSchema.parse("admitted")).toBe("admitted");
    expect(AdmissionOutcomeSchema.parse("expired")).toBe("expired");
    expect(AdmissionOutcomeSchema.parse("cancelled")).toBe("cancelled");
    expect(AdmissionOutcomeSchema.parse("rejected")).toBe("rejected");
  });

  it("validates budget defaults and snapshots", () => {
    expect(CAMPAIGN_BUDGET_DOLLARS_DEFAULT).toBe(100.0);
    expect(DEBRIEF_OPERATION_BUDGET_DOLLARS_DEFAULT).toBe(2.0);
    expect(OPERATION_INPUT_TOKEN_CEILING_DEFAULT).toBe(4_000_000);
    expect(OPERATION_OUTPUT_TOKEN_CEILING_DEFAULT).toBe(500_000);

    const campaignSnapshot = CampaignBudgetSnapshotSchema.parse({
      allowedDollars: 100.0,
      spentDollars: 0.0,
      reservedDollars: 0.0,
      remainingDollars: 100.0,
      version: 1,
      updatedAt: new Date().toISOString(),
    });
    expect(campaignSnapshot.remainingDollars).toBe(100.0);

    const operationSnapshot = OperationBudgetSnapshotSchema.parse({
      operationId: "op_1",
      runId: "run_1",
      version: 1,
      generation: 1,
      allowedDollars: 2.0,
      spentDollars: 0.0,
      reservedDollars: 0.0,
      remainingDollars: 2.0,
      allowedInputTokens: 4_000_000,
      spentInputTokens: 0,
      reservedInputTokens: 0,
      allowedOutputTokens: 500_000,
      spentOutputTokens: 0,
      reservedOutputTokens: 0,
      startedAt: new Date().toISOString(),
      elapsedProcessingMs: 0,
      status: "active",
      extensions: [],
      dispatches: 0,
    });
    expect(operationSnapshot.status).toBe("active");
  });

  it("validates known price evidence table and schema", () => {
    const known = defaultModelPriceEvidence();
    expect(known.has("deepseek/deepseek-v4.1-flash")).toBe(true);
    expect(known.has("nvidia/nemotron-3.5-lightning")).toBe(true);
    expect(known.has("nex-agi/nex-n2.5-mini:free")).toBe(true);
    expect(known.has("upstage/solar-pro4")).toBe(true);
    expect(known.has("mock")).toBe(true);

    const solar = known.get("upstage/solar-pro4")!;
    expect(ModelPriceEvidenceSchema.parse(solar)).toEqual(solar);
    expect(solar.contextWindowTokens).toBeGreaterThan(0);
  });

  it("estimates conservative tokens using UTF-8 byte bounds rather than character counts", () => {
    const system = "You are a debrief extractor.";
    const user = "Transcript text with emoji 🚀 and unicode: é, ü, 中文.";
    const schema = { type: "object", properties: { work: { type: "string" } } };

    const estimate = estimateConservativeTokens({
      system,
      user,
      schema,
      outputReserveTokens: 2048,
    });

    const parsed = TokenReservationEstimateSchema.parse(estimate);
    expect(parsed.estimatedInputTokens).toBeGreaterThan(0);
    expect(parsed.estimatedOutputTokens).toBe(2048);
    expect(parsed.estimatedTotalTokens).toBe(
      parsed.estimatedInputTokens + parsed.estimatedOutputTokens,
    );
    // Proven to use byte length, not char length: multi-byte characters inflate byte count
    const charCount = system.length + user.length + JSON.stringify(schema).length;
    const byteCount =
      Buffer.byteLength(system, "utf8") +
      Buffer.byteLength(user, "utf8") +
      Buffer.byteLength(JSON.stringify(schema), "utf8");
    expect(byteCount).toBeGreaterThan(charCount);
  });

  it("validates timeline entry and telemetry report schemas", () => {
    const timelineEntry = ModelTimelineEntrySchema.parse({
      attemptId: "att_1",
      operationId: "op_1",
      runId: "run_1",
      stage: "verification",
      enqueuedAt: new Date().toISOString(),
      admittedAt: new Date().toISOString(),
      settledAt: new Date().toISOString(),
      queueWaitMs: 120,
      durationMs: 1500,
      provider: "openrouter",
      model: "deepseek/deepseek-v4.1-flash",
      binding: "response_format",
      priority: "normal",
      outcome: "completed",
      tokens: {
        promptTokens: 1200,
        completionTokens: 350,
        totalTokens: 1550,
        estimated: false,
      },
      cost: {
        dollars: 0.000266,
        estimated: false,
        unverified: false,
      },
      failureClassification: null,
      validationOutcome: "valid",
    });
    expect(timelineEntry.tokens.totalTokens).toBe(1550);

    const report = CorpusLoadReportSchema.parse({
      measuredAt: new Date().toISOString(),
      transcriptTokenDistribution: {
        count: 10,
        minTokens: 500,
        maxTokens: 15000,
        meanTokens: 4200,
        medianTokens: 3800,
      },
      candidateDensity: {
        totalCandidates: 120,
        totalTranscriptTokens: 42000,
        candidatesPerThousandTokens: 2.857,
      },
      duplicateObservationRate: {
        totalObservations: 140,
        duplicateObservations: 20,
        duplicateRate: 0.143,
      },
      repairsByValidator: {
        verification: 2,
        responsibility: 0,
      },
      arrivalsAndDurations: [
        {
          operationId: "op_1",
          arrivedAt: new Date().toISOString(),
          totalDurationMs: 4500,
          stageDurationsMs: {
            discovery: 2000,
            verification: 2500,
          },
        },
      ],
    });
    expect(report.candidateDensity.totalCandidates).toBe(120);
  });
});
