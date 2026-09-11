import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod/v3";
import { afterEach, describe, expect, it } from "vitest";
import {
  CampaignManifestSchema,
  CampaignReportSchema,
  type CampaignCorpusRevision,
  type CampaignFreezeFacts,
  type CampaignHumanJudgment,
  type CampaignModelRoute,
  type CampaignSlot,
  type MeetingDebriefExtraction,
  type ModelTimelineEntry,
} from "@chief-of-staff-demo/shared";
import { ModelBudgetLedger } from "../../../apps/server/src/llm/budget";
import { ModelTimelineStore } from "../../../apps/server/src/llm/timeline";
import { makeCompleteJson } from "../../../apps/server/src/llm/providers";
import { createSourceLifecycleGrant } from "../../../apps/server/src/llm/grants";
import { parseResultShape } from "../../../apps/server/src/llm/failure";
import type {
  CandidateExtractionOptions,
  DebriefExtractionRun,
} from "../../../apps/server/src/modules/meeting-debrief/candidate-extraction";
import { validatedDebriefSections } from "@chief-of-staff-demo/shared";
import {
  loadCampaignCorpus,
  type LoadedCampaignCorpus,
} from "../../../apps/server/src/validation/corpus";
import {
  CampaignManifestCorruptError,
  CampaignManifestExistsError,
  CampaignManifestMismatchError,
  assertManifestMatchesPlan,
  freezeCampaignManifest,
  readCampaignManifest,
  writeCampaignManifest,
} from "../../../apps/server/src/validation/manifest";
import { defaultProtocolShape, planCampaignSlots } from "../../../apps/server/src/validation/plan";
import {
  SlotOutcomeConflictError,
  decodeOutcomes,
  deriveSlotOutcome,
  encodeOutcomes,
  finalizeCampaignOutcomes,
  recordSlotOutcome,
  statusForExtractionError,
} from "../../../apps/server/src/validation/outcome";
import {
  JudgmentConflictError,
  buildBlindJudgmentPacket,
  recordHumanJudgment,
} from "../../../apps/server/src/validation/judgments";
import {
  nearestRankPercentile,
  renderCampaignReport,
  summarizeCampaign,
} from "../../../apps/server/src/validation/stats";
import {
  TerminalOutcomeWriteError,
  writeTerminalRunOutcome,
} from "../../../apps/server/src/validation/artifacts";
import {
  extractionShapeCounts,
  renderExtractionSummary,
} from "../../../apps/server/src/validation/progress";
import { readSourceLifecycleGrant } from "../../../apps/server/src/validation/grant-file";
import {
  SlotRootNotEmptyError,
  createExtractionSlotExecutor,
  prepareColdSlotRoot,
  readCampaignOutcomes,
  runValidationCampaign,
} from "../../../apps/server/src/validation/run";
import {
  runValidationCampaignCli,
  type CampaignCliResult,
} from "../../../scripts/run-validation-campaign.mjs";

const dirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const MODELS: CampaignModelRoute[] = ["model-a", "model-b", "model-c"].map((model) => ({
  model,
  route: "mock-local",
  binding: "model-default",
  grantId: null,
}));

/** A frozen corpus revision built from real files, the way the loader derives it. */
function writeCorpus(options: {
  goldens: number;
  incidents?: number;
  briefs?: number;
  caseNames?: (index: number) => string;
}): LoadedCampaignCorpus {
  const root = tempDir("campaign-corpus-");
  const goldenDir = join(root, "golden");
  const transcriptsDir = join(goldenDir, "transcripts");
  const incidentDir = join(root, "incidents");
  const briefDir = join(root, "briefs");
  const caseNames =
    options.caseNames ?? ((index: number) => `case-${String(index).padStart(2, "0")}`);
  mkdirSync(transcriptsDir, { recursive: true });
  mkdirSync(incidentDir, { recursive: true });
  mkdirSync(briefDir, { recursive: true });
  for (let index = 1; index <= options.goldens; index++) {
    const caseId = caseNames(index);
    writeFileSync(join(transcriptsDir, `${caseId}.md`), `transcript text for ${caseId}\n`);
    writeFileSync(
      join(goldenDir, `${caseId}.json`),
      JSON.stringify({
        transcript: `${caseId}.md`,
        meetingDate: "2026-01-05",
        decisions: [],
        actionItems: [],
        openQuestions: [],
        mustNotAppear: [],
      }),
    );
  }
  for (let index = 1; index <= (options.incidents ?? 0); index++) {
    const caseId = `incident-${String(index).padStart(2, "0")}`;
    writeFileSync(join(incidentDir, `${caseId}.md`), `incident transcript text ${caseId}\n`);
  }
  for (let index = 1; index <= (options.briefs ?? 0); index++) {
    const caseId = `brief-${String(index).padStart(2, "0")}`;
    writeFileSync(join(briefDir, `${caseId}.md`), `brief transcript text ${caseId}\n`);
  }
  return loadCampaignCorpus({ goldenDir, incidentDir, briefDir });
}

function freezeFactsFor(
  corpus: CampaignCorpusRevision,
  coldRoot: string,
  models: CampaignModelRoute[] = MODELS,
): CampaignFreezeFacts {
  return {
    codeRevision: "revision-under-test",
    diffHash: "clean",
    imageDigest: "local-process",
    sourceContextHash: "a".repeat(64),
    promptHash: "b".repeat(64),
    schemaHash: "c".repeat(64),
    validatorVersion: "candidate-accounting-v12",
    corpus,
    models,
    campaignBudgetDollars: 100,
    operationBudgetDollars: 2,
    coldRoot,
  };
}

function buildPlan(options: {
  protocol?: "baseline" | "comparison" | "final" | "brief";
  goldens: number;
  incidents?: number;
  briefs?: number;
  models?: CampaignModelRoute[];
  corpus?: LoadedCampaignCorpus;
  caseNames?: (index: number) => string;
}) {
  const corpus =
    options.corpus ??
    writeCorpus({
      goldens: options.goldens,
      incidents: options.incidents ?? 0,
      briefs: options.briefs ?? 0,
      ...(options.caseNames !== undefined ? { caseNames: options.caseNames } : {}),
    });
  const coldRoot = join(tempDir("campaign-root-"), "slots");
  const models = options.models ?? MODELS;
  const protocol = options.protocol ?? "baseline";
  const freeze = freezeFactsFor(corpus.revision, coldRoot, models);
  const slots = planCampaignSlots({
    campaignId: "campaign-1",
    protocol,
    corpus: corpus.revision,
    models,
    coldRoot,
  });
  const manifest = freezeCampaignManifest({
    campaignId: "campaign-1",
    protocol,
    createdAt: "2026-09-11T00:00:00.000Z",
    freeze,
    slots,
  });
  return { corpus, slots, freeze, manifest, models, coldRoot };
}

let timelineSequence = 0;

function timelineEntry(overrides: Partial<ModelTimelineEntry>): ModelTimelineEntry {
  timelineSequence += 1;
  return {
    attemptId: `attempt-${timelineSequence}`,
    operationId: "op_slot",
    runId: null,
    stage: "discovery",
    enqueuedAt: "2026-09-11T00:00:00.000Z",
    admittedAt: "2026-09-11T00:00:00.050Z",
    settledAt: "2026-09-11T00:00:01.000Z",
    queueWaitMs: 30,
    durationMs: 950,
    provider: "mock",
    model: "model-a",
    binding: "response_format",
    priority: "normal",
    outcome: "completed",
    tokens: { promptTokens: 100, completionTokens: 20, totalTokens: 120, estimated: false },
    cost: { dollars: 0.004, estimated: false, unverified: false },
    failureClassification: null,
    validationOutcome: "valid",
    ...overrides,
  };
}

describe("campaign slot allocation", () => {
  it("derives the baseline slot count from the frozen corpus revision, never from a constant", () => {
    const withTwenty = buildPlan({ goldens: 20, incidents: 3 });
    expect(withTwenty.slots).toHaveLength(69);
    expect(defaultProtocolShape("baseline").arms).toHaveLength(1);

    const withTwentyOne = buildPlan({ goldens: 21, incidents: 3 });
    expect(withTwentyOne.slots).toHaveLength(72);
  });

  it("plans every Golden once and every incident cold, per model, under the frozen root", () => {
    const { slots, coldRoot } = buildPlan({ goldens: 2, incidents: 3 });
    const goldens = slots.filter((slot) => slot.kind === "golden");
    const incidents = slots.filter((slot) => slot.kind === "incident");
    expect(goldens).toHaveLength(2 * MODELS.length);
    expect(incidents).toHaveLength(3 * MODELS.length);
    expect(incidents.every((slot) => slot.cold)).toBe(true);
    expect(slots.every((slot) => slot.root.startsWith(`${coldRoot}/`))).toBe(true);
    expect(new Set(slots.map((slot) => slot.slotId)).size).toBe(slots.length);
    expect(new Set(slots.map((slot) => slot.root)).size).toBe(slots.length);
    expect(new Set(slots.map((slot) => slot.operationId)).size).toBe(slots.length);
  });

  it("plans the comparison, final and Brief protocol shapes from their dimensions", () => {
    const comparison = buildPlan({ protocol: "comparison", goldens: 6 });
    expect(comparison.slots).toHaveLength(6 * 3 * 2 * MODELS.length);
    expect(new Set(comparison.slots.map((slot) => slot.arm)).size).toBe(2);

    const final = buildPlan({ protocol: "final", goldens: 5 });
    expect(final.slots).toHaveLength(5 * 3 * MODELS.length);
    expect(final.slots.every((slot) => slot.cold)).toBe(true);

    const brief = buildPlan({ protocol: "brief", goldens: 0, briefs: 2 });
    expect(brief.slots).toHaveLength(2 * 3 * MODELS.length);
    expect(brief.slots.every((slot) => slot.kind === "brief")).toBe(true);
  });
});

describe("frozen campaign manifest", () => {
  it("digests the freeze facts and the planned slots", () => {
    const { freeze, slots } = buildPlan({ goldens: 2, incidents: 1 });
    const first = freezeCampaignManifest({
      campaignId: "campaign-1",
      protocol: "baseline",
      createdAt: "2026-09-11T00:00:00.000Z",
      freeze,
      slots,
    });
    const second = freezeCampaignManifest({
      campaignId: "campaign-1",
      protocol: "baseline",
      createdAt: "2026-09-11T00:00:01.000Z",
      freeze,
      slots,
    });
    expect(first.digest).toBe(second.digest);

    const changedModels = freezeCampaignManifest({
      campaignId: "campaign-1",
      protocol: "baseline",
      createdAt: "2026-09-11T00:00:00.000Z",
      freeze: { ...freeze, models: [MODELS[0], { ...MODELS[1], binding: "forced-tool-call" }] },
      slots,
    });
    expect(changedModels.digest).not.toBe(first.digest);
  });

  it("never overwrites a frozen manifest", () => {
    const { manifest } = buildPlan({ goldens: 1 });
    const dir = tempDir("campaign-record-");
    const path = writeCampaignManifest(dir, manifest);
    const bytes = readFileSync(path, "utf8");
    expect(() => writeCampaignManifest(dir, manifest)).toThrow(CampaignManifestExistsError);
    expect(readFileSync(path, "utf8")).toBe(bytes);
    expect(readCampaignManifest(dir).digest).toBe(manifest.digest);
  });

  it("refuses a plan whose frozen configuration changed after the freeze", () => {
    const { manifest, freeze, slots } = buildPlan({ goldens: 2, incidents: 1 });
    expect(() =>
      assertManifestMatchesPlan(manifest, { protocol: "baseline", freeze, slots }),
    ).not.toThrow();
    expect(() =>
      assertManifestMatchesPlan(manifest, {
        protocol: "baseline",
        freeze: { ...freeze, promptHash: "d".repeat(64) },
        slots,
      }),
    ).toThrow(CampaignManifestMismatchError);
    expect(() =>
      assertManifestMatchesPlan(manifest, {
        protocol: "baseline",
        freeze: { ...freeze, models: MODELS.slice(0, 2) },
        slots,
      }),
    ).toThrow(CampaignManifestMismatchError);
  });

  it("rejects a manifest whose bytes no longer match its digest", () => {
    const { manifest } = buildPlan({ goldens: 1 });
    const dir = tempDir("campaign-record-");
    const path = writeCampaignManifest(dir, manifest);
    const tampered = CampaignManifestSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    writeFileSync(path, JSON.stringify({ ...tampered, campaignId: "someone-else" }));
    expect(() => readCampaignManifest(dir)).toThrow(CampaignManifestCorruptError);
  });
});

describe("terminal outcomes", () => {
  it("charges attempts, retries, queue delay and cost from the ledger and timeline seams", () => {
    const { slots } = buildPlan({ goldens: 1 });
    const slot = slots[0];
    const root = tempDir("campaign-state-");
    const ledger = new ModelBudgetLedger(root);
    const grant = createSourceLifecycleGrant({
      sourceId: "source-1",
      purpose: "validation-campaign",
      model: "deepseek/deepseek-v4.1-flash",
    });
    ledger.getOrCreateOperationSnapshot(slot.operationId, null, "debrief");
    const reservation = ledger.reserve({
      operationId: slot.operationId,
      model: "deepseek/deepseek-v4.1-flash",
      system: "s",
      user: "u",
      grant,
    });
    ledger.settle(reservation.reservationId, {
      provider: "openrouter",
      model: "deepseek/deepseek-v4.1-flash",
      binding: "response_format",
      inputTokens: 1000,
      outputTokens: 500,
      costUsd: 0.0123,
      cachedInputTokens: null,
      systemFingerprint: null,
    });
    const timeline = new ModelTimelineStore(root);
    timeline.record(
      timelineEntry({ operationId: slot.operationId, queueWaitMs: 120, outcome: "failed" }),
    );
    timeline.record(timelineEntry({ operationId: slot.operationId, queueWaitMs: 30 }));

    const outcome = deriveSlotOutcome({
      slot,
      status: "success",
      processingMs: 1234.6,
      totalMs: 2000,
      timeline: timeline.getOperationTimeline(slot.operationId),
      ledger: ledger.getOperationSnapshot(slot.operationId),
      recordedAt: "2026-09-11T00:00:05.000Z",
    });
    expect(outcome.attempts).toBe(2);
    expect(outcome.chargedAttempts).toBe(2);
    expect(outcome.retries).toBe(1);
    expect(outcome.queueDelayMs).toBe(150);
    expect(outcome.processingMs).toBe(1235);
    expect(outcome.costDollars).toBeCloseTo(0.0123, 10);
    expect(outcome.costEstimated).toBe(false);
  });

  it("records exactly one terminal outcome per slot and never replaces a failure", () => {
    const { slots } = buildPlan({ goldens: 1 });
    const slot = slots[0];
    const failed = deriveSlotOutcome({
      slot,
      status: "failed",
      reason: "upstream refused",
      processingMs: 10,
      totalMs: 10,
      timeline: [],
      ledger: null,
      recordedAt: "2026-09-11T00:00:00.000Z",
    });
    const recorded = recordSlotOutcome([], failed);
    const laterSuccess = deriveSlotOutcome({
      slot,
      status: "success",
      processingMs: 5,
      totalMs: 5,
      timeline: [],
      ledger: null,
      recordedAt: "2026-09-11T00:01:00.000Z",
    });
    expect(() => recordSlotOutcome(recorded, laterSuccess)).toThrow(SlotOutcomeConflictError);
  });

  it("closes a campaign by recording missing outcomes with a reason", () => {
    const { slots } = buildPlan({ goldens: 2 });
    const recorded = deriveSlotOutcome({
      slot: slots[0],
      status: "success",
      processingMs: 5,
      totalMs: 5,
      timeline: [],
      ledger: null,
      recordedAt: "2026-09-11T00:00:00.000Z",
    });
    const closed = finalizeCampaignOutcomes({
      slots,
      outcomes: [recorded],
      reason: "campaign closed by the operator",
      recordedAt: "2026-09-11T00:10:00.000Z",
    });
    expect(closed).toHaveLength(slots.length - 1);
    expect(closed.every((outcome) => outcome.status === "missing")).toBe(true);
    expect(closed[0].reason).toBe("campaign closed by the operator");
    expect(
      finalizeCampaignOutcomes({
        slots,
        outcomes: [recorded, ...closed],
        reason: "again",
        recordedAt: "2026-09-11T00:20:00.000Z",
      }),
    ).toHaveLength(0);
  });

  it("maps an invalid model reply to schema-invalid and a transport failure to failed", () => {
    let shapeFailure: unknown = null;
    try {
      parseResultShape("Campaign-Probe", z.strictObject({ answer: z.string() }), {});
    } catch (error) {
      shapeFailure = error;
    }
    expect(statusForExtractionError(shapeFailure).status).toBe("schema-invalid");
    expect(statusForExtractionError(new Error("connection reset")).status).toBe("failed");
    const aborted = new Error("the caller aborted");
    aborted.name = "AbortError";
    expect(statusForExtractionError(aborted).status).toBe("interrupted");
  });

  it("round-trips the append-only outcome log encoding", () => {
    const { slots } = buildPlan({ goldens: 2 });
    const outcomes = slots.map((slot, index) =>
      deriveSlotOutcome({
        slot,
        status: index === 0 ? "success" : "missing",
        processingMs: index,
        totalMs: index,
        timeline: [],
        ledger: null,
        recordedAt: "2026-09-11T00:00:00.000Z",
      }),
    );
    expect(decodeOutcomes(encodeOutcomes(outcomes))).toEqual(outcomes);
  });
});

describe("campaign measurement", () => {
  it("takes the nearest-rank p95, not an interpolated quantile", () => {
    expect(nearestRankPercentile([], 0.95)).toBeNull();
    expect(nearestRankPercentile([7], 0.95)).toBe(7);
    expect(nearestRankPercentile([1, 2, 3, 4], 0.95)).toBe(4);
    expect(nearestRankPercentile([1, 2, 3, 4], 0.5)).toBe(2);
    // ceil(0.95 * 20) = rank 19, not the maximum: the approved nearest-rank rule.
    expect(
      nearestRankPercentile(
        Array.from({ length: 20 }, (_, index) => index + 1),
        0.95,
      ),
    ).toBe(19);
    expect(
      nearestRankPercentile(
        Array.from({ length: 100 }, (_, index) => index + 1),
        0.95,
      ),
    ).toBe(95);
  });

  it("counts denominators from the frozen plan, not from what ran", () => {
    const { manifest, slots } = buildPlan({ goldens: 2, models: [MODELS[0]] });
    const outcome = deriveSlotOutcome({
      slot: slots[0],
      status: "success",
      processingMs: 10,
      totalMs: 12,
      timeline: [],
      ledger: null,
      recordedAt: "2026-09-11T00:00:00.000Z",
    });
    const report = summarizeCampaign({
      manifest,
      outcomes: [outcome],
      generatedAt: "2026-09-11T00:00:00.000Z",
    });
    expect(report.planned).toBe(slots.length);
    expect(report.statusCounts.missing).toBe(slots.length - 1);
    expect(report.complete).toBe(false);
    expect(report.missing).toHaveLength(slots.length - 1);
    expect(report.completion).toEqual({ successes: 1, rate: 1 / slots.length });
    expect(report.timing.successfulSamples).toBe(1);
    expect(report.timing.p95ProcessingMs).toBe(10);
  });

  it("leaves cost per success undefined at zero successes and labels unverified spend", () => {
    const { manifest, slots } = buildPlan({ goldens: 2, models: [MODELS[0]] });
    const zero = summarizeCampaign({
      manifest,
      outcomes: slots.map((slot) =>
        deriveSlotOutcome({
          slot,
          status: "failed",
          reason: "budget exhausted",
          processingMs: 0,
          totalMs: 0,
          timeline: [
            timelineEntry({
              operationId: slot.operationId,
              cost: { dollars: 0.25, estimated: true, unverified: true },
            }),
          ],
          ledger: null,
          recordedAt: "2026-09-11T00:00:00.000Z",
        }),
      ),
      generatedAt: "2026-09-11T00:00:00.000Z",
    });
    expect(zero.cost.successfulCompletions).toBe(0);
    expect(zero.cost.perSuccessDollars).toBeNull();
    expect(zero.cost.totalDollars).toBeCloseTo(0.5, 10);
    expect(zero.cost.estimatedDollars).toBeCloseTo(0.5, 10);
    expect(zero.cost.unverifiedDollars).toBeCloseTo(0.5, 10);

    const one = summarizeCampaign({
      manifest,
      outcomes: slots.map((slot, index) =>
        deriveSlotOutcome({
          slot,
          status: index === 0 ? "success" : "failed",
          processingMs: index + 1,
          totalMs: index + 1,
          timeline: [
            timelineEntry({
              operationId: slot.operationId,
              cost: { dollars: 0.4, estimated: false, unverified: false },
            }),
          ],
          ledger: null,
          recordedAt: "2026-09-11T00:00:00.000Z",
        }),
      ),
      generatedAt: "2026-09-11T00:00:00.000Z",
    });
    expect(one.cost.perSuccessDollars).toBeCloseTo(0.8, 10);
  });

  it("reports zero-denominator semantic categories as not applicable", () => {
    const { manifest, slots } = buildPlan({ goldens: 2, models: [MODELS[0]] });
    const empty = summarizeCampaign({
      manifest,
      outcomes: [],
      generatedAt: "2026-09-11T00:00:00.000Z",
    });
    expect(empty.semantic).toHaveLength(7);
    expect(empty.semantic.every((entry) => entry.applicable === false)).toBe(true);
    expect(empty.semantic.every((entry) => entry.rate === null)).toBe(true);

    const judgment: CampaignHumanJudgment = {
      judgmentId: "judgment-1",
      campaignId: manifest.campaignId,
      slotId: slots[0].slotId,
      adjudicator: "owner",
      blinded: true,
      adjudicatedAt: "2026-09-11T00:00:00.000Z",
      counts: {
        falseActions: 1,
        missedActions: 0,
        wrongResponsibility: 0,
        wrongDates: 2,
        wrongMerges: 0,
        falseDecisions: 0,
        unsupportedHandoffDetails: 0,
        producedActions: 4,
        expectedObligations: 3,
        responsibilityAssertions: 0,
        interpretedDates: 2,
        mergeDecisions: 0,
        producedDecisions: 0,
        assessedDetails: 0,
      },
    };
    const adjudicated = summarizeCampaign({
      manifest,
      outcomes: [],
      humanJudgments: [judgment],
      generatedAt: "2026-09-11T00:00:00.000Z",
    });
    const falseActions = adjudicated.semantic.find(
      (entry) => entry.category === "false-actions-per-produced-action",
    )!;
    expect(falseActions).toMatchObject({
      numerator: 1,
      denominator: 4,
      applicable: true,
      rate: 0.25,
    });
    const wrongDates = adjudicated.semantic.find(
      (entry) => entry.category === "wrong-dates-per-interpreted-date",
    )!;
    expect(wrongDates.rate).toBe(1);
    const merges = adjudicated.semantic.find(
      (entry) => entry.category === "wrong-merges-per-merge-decision",
    )!;
    expect(merges.applicable).toBe(false);
  });

  it("keeps Golden scores distinct from privately retained blind judgments", () => {
    const { manifest, slots } = buildPlan({ goldens: 1, models: [MODELS[0]] });
    const report = summarizeCampaign({
      manifest,
      outcomes: [],
      goldenScores: [
        {
          slotId: slots[0].slotId,
          golden: "case-01",
          passed: true,
          failures: [],
          scoredAt: "2026-09-11T00:00:00.000Z",
        },
      ],
      humanJudgments: [
        {
          judgmentId: "judgment-1",
          campaignId: manifest.campaignId,
          slotId: slots[0].slotId,
          adjudicator: "owner",
          blinded: true,
          adjudicatedAt: "2026-09-11T00:00:00.000Z",
          counts: {
            falseActions: 0,
            missedActions: 0,
            wrongResponsibility: 0,
            wrongDates: 0,
            wrongMerges: 0,
            falseDecisions: 0,
            unsupportedHandoffDetails: 0,
            producedActions: 1,
            expectedObligations: 1,
            responsibilityAssertions: 0,
            interpretedDates: 0,
            mergeDecisions: 0,
            producedDecisions: 0,
            assessedDetails: 0,
          },
        },
      ],
      generatedAt: "2026-09-11T00:00:00.000Z",
    });
    expect(CampaignReportSchema.parse(report).goldenScores).toHaveLength(1);
    expect(report.goldenScores[0].golden).toBe("case-01");
    expect(report.humanJudgments[0].blinded).toBe(true);
    expect(report.humanJudgments[0].slotId).toBe(report.goldenScores[0].slotId);
    expect(Object.keys(report.humanJudgments[0])).not.toContain("passed");
  });
});

describe("blind human judgments", () => {
  it("builds an adjudication packet without the model or arm identity", () => {
    const { slots } = buildPlan({ goldens: 1 });
    const slot = slots[0];
    const packet = buildBlindJudgmentPacket({
      slot,
      produced: { summary: "produced", actionItems: [] } as unknown as MeetingDebriefExtraction,
      expected: { actionItems: [] },
    });
    const serialized = JSON.stringify(packet);
    expect(serialized).not.toContain(slot.model);
    expect(serialized).not.toContain(slot.arm);
    expect(serialized).not.toContain(slot.slotId);
    expect(packet.caseId).toBe(slot.caseId);
  });

  it("never rewrites a retained judgment", () => {
    const judgment: CampaignHumanJudgment = {
      judgmentId: "judgment-1",
      campaignId: "campaign-1",
      slotId: "slot-1",
      adjudicator: "owner",
      blinded: true,
      adjudicatedAt: "2026-09-11T00:00:00.000Z",
      counts: {
        falseActions: 0,
        missedActions: 0,
        wrongResponsibility: 0,
        wrongDates: 0,
        wrongMerges: 0,
        falseDecisions: 0,
        unsupportedHandoffDetails: 0,
        producedActions: 0,
        expectedObligations: 0,
        responsibilityAssertions: 0,
        interpretedDates: 0,
        mergeDecisions: 0,
        producedDecisions: 0,
        assessedDetails: 0,
      },
    };
    const retained = recordHumanJudgment([], judgment);
    expect(() => recordHumanJudgment(retained, judgment)).toThrow(JudgmentConflictError);
  });
});

describe("ordinary output carries no source", () => {
  it("reports extraction shape, never titles, owners or dates", () => {
    const extraction = {
      summary: "Merge the pricing decision",
      decisions: [{ title: "ZZTITLE-DECISION" }],
      actionItems: [{ title: "ZZTITLE-ACTION", owner: "ZZOWNER", dueDate: "2031-01-02" }],
      openQuestions: [{ question: "ZZQUESTION?" }],
      suggestedRecipients: [{ name: "ZZRECIPIENT" }],
    };
    const line = renderExtractionSummary("[model-a 1/1]", 42, extractionShapeCounts(extraction));
    expect(line).toContain("summary=26ch");
    expect(line).toContain("actions=1");
    for (const leak of [
      "ZZTITLE-DECISION",
      "ZZTITLE-ACTION",
      "ZZOWNER",
      "2031-01-02",
      "ZZQUESTION?",
      "ZZRECIPIENT",
    ]) {
      expect(line).not.toContain(leak);
    }
  });

  it("renders the campaign report without case ids or produced content", () => {
    const { manifest, slots } = buildPlan({ goldens: 1, models: [MODELS[0]] });
    const report = summarizeCampaign({
      manifest,
      outcomes: [
        deriveSlotOutcome({
          slot: slots[0],
          status: "failed",
          reason: "the model refused",
          processingMs: 5,
          totalMs: 6,
          timeline: [],
          ledger: null,
          recordedAt: "2026-09-11T00:00:00.000Z",
        }),
      ],
      generatedAt: "2026-09-11T00:00:00.000Z",
    });
    const rendered = renderCampaignReport(report);
    expect(rendered).toContain("planned 1");
    expect(rendered).toContain("slot #0");
    expect(rendered).not.toContain(slots[0].caseId);
  });
});

describe("terminal run artifacts", () => {
  it("writes exactly one terminal file, removing the other outcome", () => {
    const dir = tempDir("terminal-artifacts-");
    const outFile = join(dir, "run.debrief.json");
    const errFile = join(dir, "run.error.json");
    writeFileSync(errFile, "{}");
    writeTerminalRunOutcome({ outFile, errFile, kind: "success", body: { ok: true } });
    expect(existsSync(outFile)).toBe(true);
    expect(existsSync(errFile)).toBe(false);

    writeTerminalRunOutcome({ outFile, errFile, kind: "failure", body: { failed: true } });
    expect(existsSync(outFile)).toBe(false);
    expect(existsSync(errFile)).toBe(true);
    expect(JSON.parse(readFileSync(errFile, "utf8"))).toEqual({ failed: true });
  });

  it("surfaces a failed serialization instead of leaving the slot with neither file", () => {
    const dir = tempDir("terminal-artifacts-");
    expect(() =>
      writeTerminalRunOutcome({
        outFile: join(dir, "out.json"),
        errFile: join(dir, "err.json"),
        kind: "success",
        body: { ok: true },
        writeFile: () => {
          throw new Error("ENOSPC: no space left on device");
        },
      }),
    ).toThrow(TerminalOutcomeWriteError);
  });
});

describe("campaign runner and extraction executor", () => {
  function extractionFixture(): MeetingDebriefExtraction {
    return {
      summary: "summary",
      decisions: [],
      actionItems: [],
      openQuestions: [],
      suggestedRecipients: [],
    } as unknown as MeetingDebriefExtraction;
  }

  /**
   * One finished extraction, as the pipeline's whole-run seam returns it
   * (#345). The campaign executor reads `extraction` and the ids; the checked
   * core the production pipeline commits is described here as the empty one
   * this fixture actually checks, and its sections all validated because the
   * injected extraction is a complete revision.
   */
  function extractionRun(): DebriefExtractionRun {
    return {
      extraction: extractionFixture(),
      checkedAliases: [],
      core: {
        sourceChecksum: "campaign-fixture",
        candidates: [],
        dispositions: [],
        actions: [],
        retainedIds: [],
      },
      sections: validatedDebriefSections(),
    };
  }

  function extractionExecutor(
    corpus: LoadedCampaignCorpus,
    stateDir: string,
    extract: ((options: CandidateExtractionOptions) => Promise<DebriefExtractionRun>) | undefined,
    writeFile?: (path: string, contents: string) => void,
  ) {
    const ledger = new ModelBudgetLedger(stateDir);
    const timeline = new ModelTimelineStore(stateDir);
    const grant = createSourceLifecycleGrant({
      sourceId: "source-1",
      purpose: "validation-campaign",
      model: "mock",
    });
    const byCase = new Map(corpus.cases.map((entry) => [entry.caseId, entry]));
    return createExtractionSlotExecutor({
      transcriptFor: (caseId) => {
        const entry = byCase.get(caseId)!;
        return { path: entry.transcriptPath, file: entry.transcriptFile };
      },
      completeFor: () =>
        makeCompleteJson(
          { provider: "mock", model: "mock", apiKey: "" },
          join(stateDir, "absent.json"),
          { budgetLedger: ledger, timelineStore: timeline },
        ),
      identity: { mentions: [], decisions: [], organizations: [] },
      grantFor: () => grant,
      strategy: "candidate-accounting-v12",
      ledger,
      timeline,
      ...(extract !== undefined ? { extract } : {}),
      ...(writeFile !== undefined ? { writeFile } : {}),
    });
  }

  it("records a failed terminal outcome when the artifact cannot be serialized", async () => {
    const corpus = writeCorpus({ goldens: 1 });
    const { manifest } = buildPlan({ goldens: 1, corpus, models: [MODELS[0]] });
    const campaignDir = tempDir("campaign-record-");
    writeCampaignManifest(campaignDir, manifest);
    const stateDir = tempDir("campaign-state-");
    const executor = extractionExecutor(
      corpus,
      stateDir,
      async () => extractionRun(),
      () => {
        throw new Error("ENOSPC: no space left on device");
      },
    );
    const { outcomes, report } = await runValidationCampaign({
      campaignDir,
      executor,
      concurrency: 1,
    });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].status).toBe("failed");
    expect(outcomes[0].reason).toMatch(/Could not write the terminal outcome/);
    expect(readCampaignOutcomes(campaignDir)).toHaveLength(1);
    expect(report.completion.successes).toBe(0);
    // The slot is accounted for: a recorded failure is a terminal outcome, so
    // the campaign is complete even though nothing succeeded.
    expect(report.complete).toBe(true);
    expect(report.statusCounts.failed).toBe(1);
    expect(report.missing).toHaveLength(0);
  });

  it("runs a cold slot through the budget and timeline seams and resumes without replacing it", async () => {
    const corpus = writeCorpus({ goldens: 1 });
    const { manifest } = buildPlan({ goldens: 1, corpus, models: [MODELS[0]] });
    const campaignDir = tempDir("campaign-record-");
    writeCampaignManifest(campaignDir, manifest);
    const stateDir = tempDir("campaign-state-");
    const seen: { checkpoint: unknown; operationId: string | undefined; grant: unknown }[] = [];
    const executor = extractionExecutor(corpus, stateDir, async (options) => {
      seen.push({
        checkpoint: options.checkpoint,
        operationId: options.operationId,
        grant: options.grant,
      });
      await options.complete({
        system: "system",
        user: "user",
        schema: z.strictObject({ ok: z.boolean() }),
        operationId: options.operationId,
        sourceGrant: options.grant,
        stage: "probe",
      });
      return extractionRun();
    });
    const first = await runValidationCampaign({ campaignDir, executor, concurrency: 1 });
    expect(first.outcomes).toHaveLength(1);
    const outcome = first.outcomes[0];
    expect(outcome.status).toBe("success");
    expect(outcome.chargedAttempts).toBe(1);
    expect(outcome.costDollars).toBe(0);
    // Total elapsed time covers the slot's own turn; processing time does not.
    expect(outcome.totalMs).toBeGreaterThanOrEqual(outcome.processingMs);
    expect(readFileSync(outcome.artifactPath!, "utf8")).toContain('"valid": true');
    expect(seen[0].checkpoint).toBeUndefined();
    expect(seen[0].operationId).toBe(manifest.slots[0].operationId);
    expect(seen[0].grant).not.toBeNull();

    const second = await runValidationCampaign({
      campaignDir,
      executor: {
        execute: async () => {
          throw new Error("a recorded slot must not run again");
        },
      },
      concurrency: 1,
    });
    expect(second.outcomes).toHaveLength(1);
    expect(second.outcomes[0].status).toBe("success");
  });

  it("closes an interrupted campaign by recording missing slots with a reason", async () => {
    const corpus = writeCorpus({ goldens: 2 });
    const { manifest } = buildPlan({ goldens: 2, corpus, models: [MODELS[0]] });
    const campaignDir = tempDir("campaign-record-");
    writeCampaignManifest(campaignDir, manifest);
    const stateDir = tempDir("campaign-state-");
    const stopping = new AbortController();
    const executor = extractionExecutor(corpus, stateDir, async () => {
      stopping.abort();
      return extractionRun();
    });
    const { outcomes, report } = await runValidationCampaign({
      campaignDir,
      executor,
      concurrency: 1,
      signal: stopping.signal,
      closeIncomplete: { reason: "campaign closed before every planned slot ran" },
    });
    expect(outcomes).toHaveLength(2);
    expect(report.statusCounts.success).toBe(1);
    expect(report.statusCounts.missing).toBe(1);
    expect(report.missing[0].reason).toBe("campaign closed before every planned slot ran");
    expect(report.complete).toBe(false);
  });

  it("keeps cold slot roots isolated", async () => {
    const corpus = writeCorpus({ goldens: 1 });
    const { manifest } = buildPlan({ goldens: 1, corpus, models: [MODELS[0]] });
    const slot: CampaignSlot = manifest.slots[0];
    prepareColdSlotRoot(slot.root);
    writeFileSync(join(slot.root, "already-there.json"), "{}");
    expect(() => prepareColdSlotRoot(slot.root)).toThrow(SlotRootNotEmptyError);
  });

  it("records a schema-invalid reply as a terminal outcome with its error artifact", async () => {
    const corpus = writeCorpus({ goldens: 1 });
    const { manifest } = buildPlan({ goldens: 1, corpus, models: [MODELS[0]] });
    const campaignDir = tempDir("campaign-record-");
    writeCampaignManifest(campaignDir, manifest);
    const stateDir = tempDir("campaign-state-");
    const executor = extractionExecutor(corpus, stateDir, async () => {
      parseResultShape("Campaign-Probe", z.strictObject({ answer: z.string() }), {});
      return extractionRun();
    });
    const { outcomes } = await runValidationCampaign({ campaignDir, executor, concurrency: 1 });
    expect(outcomes[0].status).toBe("schema-invalid");
    expect(outcomes[0].artifactPath).toMatch(/\.error\.json$/);
    expect(existsSync(outcomes[0].artifactPath!)).toBe(true);
  });
});

describe("live campaign authorization", () => {
  it("accepts a validation-campaign grant file and refuses anything else", () => {
    const dir = tempDir("campaign-grant-");
    const valid = join(dir, "grant.json");
    writeFileSync(
      valid,
      JSON.stringify({
        id: "grant-1",
        sourceId: "source-1",
        purpose: "validation-campaign",
        grantedBy: "owner",
        grantedAt: "2026-09-11T00:00:00.000Z",
        revokedAt: null,
        routePolicy: { zdrRequired: true, dataCollection: "deny" },
      }),
    );
    const grant = readSourceLifecycleGrant(valid);
    expect(grant.id).toBe("grant-1");
    expect(grant.routePolicy.zdrRequired).toBe(true);

    const wrongPurpose = join(dir, "wrong-purpose.json");
    writeFileSync(
      wrongPurpose,
      JSON.stringify({
        id: "grant-2",
        sourceId: "source-1",
        purpose: "meeting-brief",
        routePolicy: { zdrRequired: true, dataCollection: "deny" },
      }),
    );
    expect(() => readSourceLifecycleGrant(wrongPurpose)).toThrow(
      /not a valid validation-campaign grant/,
    );
    expect(() => readSourceLifecycleGrant(join(dir, "absent.json"))).toThrow(
      /Could not read the source lifecycle grant/,
    );
  });
});

function cliCorpus(marker: string): {
  corpusDir: string;
  incidentsDir: string;
  mockResult: string;
  caseIds: string[];
} {
  const root = tempDir("campaign-cli-");
  const corpusDir = join(root, "corpus");
  const transcripts = join(corpusDir, "transcripts");
  const incidentsDir = join(root, "incidents");
  mkdirSync(transcripts, { recursive: true });
  mkdirSync(incidentsDir, { recursive: true });
  const caseIds: string[] = [];
  for (let index = 1; index <= 2; index++) {
    const caseId = `${marker}-case-${index}`;
    caseIds.push(caseId);
    writeFileSync(join(transcripts, `${caseId}.md`), `${marker} transcript body 2031-01-02\n`);
    writeFileSync(
      join(corpusDir, `${caseId}.json`),
      JSON.stringify({
        transcript: `${caseId}.md`,
        meetingDate: "2031-01-02",
        decisions: [],
        actionItems: [],
        openQuestions: [],
        mustNotAppear: [],
      }),
    );
  }
  writeFileSync(join(incidentsDir, `${marker}-incident-1.md`), `${marker} incident body\n`);
  const mockResult = join(root, "mock-result.json");
  writeFileSync(
    mockResult,
    JSON.stringify({
      summary: `${marker} produced summary`,
      tasks: [{ title: `${marker}-TITLE`, owner: `${marker}-OWNER`, due: "2031-02-03" }],
      drafts: [],
    }),
  );
  return { corpusDir, incidentsDir, mockResult, caseIds };
}

function spawnCampaignCli(args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/run-validation-campaign.mts", ...args],
    {
      cwd: fileURLToPath(new URL("../../../", import.meta.url)),
      encoding: "utf8",
      env: { ...process.env, OPENROUTER_API_KEY: "" },
    },
  );
  if (result.status === null) {
    throw new Error(`the campaign CLI did not exit: ${result.error?.message ?? "unknown"}`);
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function cliArgs(options: {
  campaignId: string;
  corpusDir: string;
  incidentsDir: string;
  mockResult: string;
  outDir: string;
  extra?: string[];
}): string[] {
  return [
    "--campaign-id",
    options.campaignId,
    "--corpus",
    options.corpusDir,
    "--incidents",
    options.incidentsDir,
    "--models",
    "mock",
    "--provider",
    "mock",
    "--mock-result",
    options.mockResult,
    "--out",
    options.outDir,
    ...(options.extra ?? []),
  ];
}

describe("campaign CLI", () => {
  it("freezes a manifest and records one outcome per planned slot without leaking source", () => {
    const marker = "ZLEAK";
    const { corpusDir, incidentsDir, mockResult, caseIds } = cliCorpus(marker);
    const outDir = tempDir("campaign-out-");
    const result = spawnCampaignCli(
      cliArgs({ campaignId: "campaign-cli-test", corpusDir, incidentsDir, mockResult, outDir }),
    );
    // The mock replies cannot satisfy the extraction contract, so every slot
    // ends schema-invalid and the CLI exits non-zero — with a complete record.
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("planned 3 slots");
    expect(result.stdout).toContain("report:");
    const outcomes = readCampaignOutcomes(outDir);
    expect(outcomes).toHaveLength(3);
    expect(new Set(outcomes.map((outcome) => outcome.slotId)).size).toBe(3);
    expect(outcomes.every((outcome) => outcome.status === "schema-invalid")).toBe(true);
    const report = CampaignReportSchema.parse(
      JSON.parse(readFileSync(join(outDir, "report.json"), "utf8")),
    );
    expect(report.planned).toBe(3);
    expect(report.completion.successes).toBe(0);
    const manifestBytes = readFileSync(join(outDir, "manifest.json"), "utf8");
    expect(CampaignManifestSchema.parse(JSON.parse(manifestBytes)).slots).toHaveLength(3);

    for (const leak of [marker, "2031-01-02", "2031-02-03", ...caseIds]) {
      expect(result.stdout).not.toContain(leak);
      expect(result.stderr).not.toContain(leak);
    }
    // The frozen manifest is the private record: it alone maps slots to cases.
    expect(manifestBytes).toContain(caseIds[0]);
  });

  it("freezes the plan without dispatching in plan-only mode", async () => {
    const { corpusDir, incidentsDir, mockResult } = cliCorpus("ZPLAN");
    const outDir = tempDir("campaign-out-");
    const result: CampaignCliResult = await runValidationCampaignCli(
      cliArgs({
        campaignId: "campaign-plan-test",
        corpusDir,
        incidentsDir,
        mockResult,
        outDir,
        extra: ["--plan-only"],
      }),
      {},
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("planned 3 slots");
    expect(existsSync(join(outDir, "manifest.json"))).toBe(true);
    expect(existsSync(join(outDir, "outcomes.jsonl"))).toBe(false);
    expect(existsSync(join(outDir, "slots"))).toBe(false);
  });

  it("rebuilds a campaign report from the record, including privately retained judgments", async () => {
    const { corpusDir, incidentsDir, mockResult } = cliCorpus("ZREPORT");
    const outDir = tempDir("campaign-out-");
    const run = await runValidationCampaignCli(
      cliArgs({ campaignId: "campaign-report-test", corpusDir, incidentsDir, mockResult, outDir }),
      {},
    );
    expect(run.status).toBe(1);
    const slotId = readCampaignOutcomes(outDir)[0].slotId;
    const zeroCounts = {
      falseActions: 0,
      missedActions: 0,
      wrongResponsibility: 0,
      wrongDates: 0,
      wrongMerges: 0,
      falseDecisions: 0,
      unsupportedHandoffDetails: 0,
      producedActions: 0,
      expectedObligations: 0,
      responsibilityAssertions: 0,
      interpretedDates: 0,
      mergeDecisions: 0,
      producedDecisions: 0,
      assessedDetails: 0,
    };
    writeFileSync(
      join(outDir, "golden-scores.jsonl"),
      `${JSON.stringify({ slotId, golden: "case-01", passed: false, failures: ["floor"], scoredAt: "2026-09-11T00:00:00.000Z" })}\n`,
    );
    writeFileSync(
      join(outDir, "judgments.jsonl"),
      `${JSON.stringify({
        judgmentId: "judgment-1",
        campaignId: "campaign-report-test",
        slotId,
        adjudicator: "owner",
        blinded: true,
        adjudicatedAt: "2026-09-11T00:00:00.000Z",
        counts: { ...zeroCounts, producedActions: 2, falseActions: 1 },
      })}\n`,
    );
    const report = await runValidationCampaignCli(["--report", outDir], {});
    expect(report.status).toBe(0);
    expect(report.stdout).toContain("golden scores: 1; blind human judgments: 1");
    expect(report.stdout).toContain("semantic false-actions-per-produced-action: 1/2 (50.0%)");
    expect(report.stdout).not.toContain("case-01");
  });
});

describe("eval CLI terminal outcomes", () => {
  const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

  it("writes the single-model runner's error record when its input cannot be read", () => {
    const outDir = tempDir("debrief-eval-");
    const missing = join(tempDir("debrief-input-"), "missing-transcript.md");
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/run-debrief-eval.mts", "mock/model", outDir, missing],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: { ...process.env, OPENROUTER_API_KEY: "test-key" },
      },
    );
    expect(result.status).toBe(1);
    const errorFile = join(outDir, "missing-transcript.md.error.json");
    expect(existsSync(errorFile)).toBe(true);
    expect(readFileSync(errorFile, "utf8")).toContain("ENOENT");
    expect(existsSync(join(outDir, "missing-transcript.md.debrief.json"))).toBe(false);
  });

  it("writes the fan-out runner's error record when a task crashes outside extraction", () => {
    const globDir = tempDir("debrief-glob-");
    // A directory whose name matches the glob makes the transcript read fail
    // before any provider call, which is the crash path a slot must survive.
    mkdirSync(join(globDir, "broken-transcript.md"));
    const outDir = tempDir("debrief-fanout-");
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/run-debrief-eval-all.mts",
        "--models",
        "mock/model",
        "--glob",
        join(globDir, "*.md"),
        "--outdir",
        outDir,
        "--concurrency",
        "1",
      ],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: { ...process.env, OPENROUTER_API_KEY: "test-key" },
      },
    );
    expect(result.status).toBe(1);
    const errorFile = join(outDir, "mock-model", "broken-transcript.md.error.json");
    expect(existsSync(errorFile)).toBe(true);
    expect(existsSync(join(outDir, "mock-model", "broken-transcript.md.debrief.json"))).toBe(false);
    expect(result.stdout).not.toContain(" owner ");
  });
});
