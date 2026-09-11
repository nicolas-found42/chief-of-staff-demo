import { describe, expect, it } from "vitest";
import type {
  ModelTimelineEntry,
  PersonResearchOperationOutcome,
} from "@chief-of-staff-demo/shared";
import {
  PERSON_PROFILE_CALL_SITES,
  buildPersonProfileCostSummary,
  summarizeCallSites,
  summarizeCriticalPath,
  summarizeUsefulOutput,
} from "../../../apps/server/src/llm/decision-summary.js";

/**
 * The Step 0 decision summaries of issue #381 read only two records: the
 * durable timeline entries the model seam already writes, and the research
 * operation's own outcome. These specs pin the accounting rules the report
 * rests on — production call sites only, exact repeats against earlier
 * validated successes, critical path apart from summed service time, and
 * dollars paired with what the operation published.
 */
const EXTRACTION = "person-research:extraction";
const CLAIMS = "person-profile:claims";
const PLANNING = "person-research:planning";
/** A judge/evaluation charge that shares the timeline but not the production budget. */
const EVALUATION = "debrief:evaluation";

function fingerprint(seed: string): string {
  return seed.repeat(64).slice(0, 64);
}

function entry(overrides: Partial<ModelTimelineEntry> = {}): ModelTimelineEntry {
  return {
    attemptId: "att_1",
    operationId: "op_1",
    runId: "run_1",
    stage: "person-research",
    enqueuedAt: "2026-09-11T10:00:00.000Z",
    admittedAt: "2026-09-11T10:00:00.000Z",
    settledAt: "2026-09-11T10:00:00.100Z",
    queueWaitMs: 0,
    durationMs: 100,
    provider: "openrouter",
    model: "test/model",
    binding: "response_format",
    priority: "normal",
    outcome: "completed",
    tokens: { promptTokens: 100, completionTokens: 20, totalTokens: 120, estimated: false },
    cost: { dollars: 0.001, estimated: false, unverified: false },
    ...overrides,
  };
}

function outcome(
  overrides: Partial<PersonResearchOperationOutcome> = {},
): PersonResearchOperationOutcome {
  return {
    operationId: "op_1",
    profileId: "profile_1",
    conclusion: "completed",
    startedAt: "2026-09-11T10:00:00.000Z",
    finishedAt: "2026-09-11T10:05:00.000Z",
    rounds: 3,
    modelCalls: 5,
    requests: 12,
    sourcesRetained: 4,
    claimsPublished: 2,
    coverage: [],
    leads: [],
    attempts: [],
    gaps: [],
    detail: "Covered the planned areas; two gaps remain.",
    ...overrides,
  };
}

describe("calls and dollars by call site", () => {
  it("names the three production call sites and nothing else", () => {
    expect(PERSON_PROFILE_CALL_SITES).toEqual([EXTRACTION, CLAIMS, PLANNING]);
  });

  it("sums calls, dollars and tokens per group, reporting the first entry's purpose", () => {
    const summaries = summarizeCallSites([
      entry({
        callSite: EXTRACTION,
        purpose: "personResearchB",
        admittedAt: "2026-09-11T10:00:10.000Z",
        cost: { dollars: 0.004, estimated: false, unverified: false },
        tokens: { promptTokens: 900, completionTokens: 100, totalTokens: 1000, estimated: false },
      }),
      entry({
        callSite: CLAIMS,
        purpose: "personResearch",
        cost: { dollars: 0.002, estimated: false, unverified: false },
        tokens: { promptTokens: 180, completionTokens: 20, totalTokens: 200, estimated: false },
      }),
      entry({
        callSite: EXTRACTION,
        purpose: "personResearch",
        admittedAt: "2026-09-11T10:00:00.000Z",
        cost: { dollars: 0.006, estimated: false, unverified: false },
        tokens: { promptTokens: 450, completionTokens: 50, totalTokens: 500, estimated: false },
      }),
    ]);

    expect(summaries).toEqual([
      {
        callSite: CLAIMS,
        purpose: "personResearch",
        calls: 1,
        dollars: 0.002,
        totalTokens: 200,
        cachedTokens: 0,
        exactRepeatCalls: 0,
      },
      {
        callSite: EXTRACTION,
        purpose: "personResearch",
        calls: 2,
        dollars: 0.01,
        totalTokens: 1500,
        cachedTokens: 0,
        exactRepeatCalls: 0,
      },
    ]);
  });

  it("sums provider prompt-cache hits per group, treating an unreported hit as none", () => {
    const summaries = summarizeCallSites([
      entry({
        callSite: EXTRACTION,
        admittedAt: "2026-09-11T10:00:00.000Z",
        cachedPromptTokens: 11406,
      }),
      entry({
        callSite: EXTRACTION,
        admittedAt: "2026-09-11T10:00:10.000Z",
        cachedPromptTokens: null,
      }),
      entry({ callSite: EXTRACTION, admittedAt: "2026-09-11T10:00:20.000Z" }),
      entry({ callSite: CLAIMS }),
    ]);

    expect(summaries).toMatchObject([
      { callSite: CLAIMS, calls: 1, cachedTokens: 0 },
      { callSite: EXTRACTION, calls: 3, cachedTokens: 11406 },
    ]);
  });

  it("counts a repeated exact request whose earlier occurrence completed", () => {
    const summaries = summarizeCallSites([
      entry({
        callSite: CLAIMS,
        admittedAt: "2026-09-11T10:00:20.000Z",
        requestFingerprint: fingerprint("a"),
      }),
      entry({
        callSite: CLAIMS,
        admittedAt: "2026-09-11T10:00:00.000Z",
        requestFingerprint: fingerprint("a"),
      }),
    ]);

    expect(summaries).toEqual([
      {
        callSite: CLAIMS,
        purpose: undefined,
        calls: 2,
        dollars: 0.002,
        totalTokens: 240,
        cachedTokens: 0,
        exactRepeatCalls: 1,
      },
    ]);
  });

  it("does not count a repeat whose predecessors never validated", () => {
    const summaries = summarizeCallSites([
      entry({
        callSite: PLANNING,
        outcome: "failed",
        admittedAt: "2026-09-11T10:00:00.000Z",
        requestFingerprint: fingerprint("b"),
      }),
      entry({
        callSite: PLANNING,
        outcome: "failed",
        admittedAt: "2026-09-11T10:00:05.000Z",
        requestFingerprint: fingerprint("b"),
      }),
    ]);

    expect(summaries).toMatchObject([{ callSite: PLANNING, calls: 2, exactRepeatCalls: 0 }]);
  });

  it("excludes a call site outside the allowlist from every group and total", () => {
    const entries = [
      entry({ callSite: EXTRACTION, cost: { dollars: 0.5, estimated: false, unverified: false } }),
      entry({ callSite: EVALUATION, cost: { dollars: 9.99, estimated: false, unverified: false } }),
      entry({ cost: { dollars: 3.5, estimated: false, unverified: false } }),
    ];

    const production = summarizeCallSites(entries);
    expect(production).toEqual([
      {
        callSite: EXTRACTION,
        purpose: undefined,
        calls: 1,
        dollars: 0.5,
        totalTokens: 120,
        cachedTokens: 0,
        exactRepeatCalls: 0,
      },
    ]);

    /* The allowlist is the accounting rule, not an attribution rule: the same
       entries summarized for the evaluation purpose include the judge charge. */
    expect(summarizeCallSites(entries, [EVALUATION])).toEqual([
      {
        callSite: EVALUATION,
        purpose: undefined,
        calls: 1,
        dollars: 9.99,
        totalTokens: 120,
        cachedTokens: 0,
        exactRepeatCalls: 0,
      },
    ]);
  });
});

describe("critical path apart from summed service time", () => {
  it("equals the sum when calls ran one after another", () => {
    const summary = summarizeCriticalPath([
      entry({ admittedAt: "2026-09-11T10:00:00.000Z", settledAt: "2026-09-11T10:00:00.100Z" }),
      entry({ admittedAt: "2026-09-11T10:00:00.100Z", settledAt: "2026-09-11T10:00:00.200Z" }),
    ]);

    expect(summary).toEqual({ summedServiceMs: 200, criticalPathMs: 200, entryCount: 2 });
  });

  it("merges overlapping calls so the critical path is the wall clock, not the bill", () => {
    const summary = summarizeCriticalPath([
      entry({ admittedAt: "2026-09-11T10:00:00.000Z", settledAt: "2026-09-11T10:00:00.100Z" }),
      entry({ admittedAt: "2026-09-11T10:00:00.000Z", settledAt: "2026-09-11T10:00:00.100Z" }),
      entry({ admittedAt: "2026-09-11T10:00:00.050Z", settledAt: "2026-09-11T10:00:00.150Z" }),
    ]);

    expect(summary).toEqual({ summedServiceMs: 300, criticalPathMs: 150, entryCount: 3 });
  });

  it("keeps an unparseable or inverted entry's service time but no span", () => {
    const summary = summarizeCriticalPath([
      entry({ admittedAt: "2026-09-11T10:00:00.000Z", settledAt: "2026-09-11T10:00:00.100Z" }),
      entry({
        admittedAt: "not-a-timestamp",
        settledAt: "2026-09-11T10:00:00.300Z",
        durationMs: 250,
        outcome: "failed",
      }),
      entry({
        admittedAt: "2026-09-11T10:00:00.400Z",
        settledAt: "2026-09-11T10:00:00.300Z",
        durationMs: 50,
        outcome: "cancelled",
      }),
    ]);

    expect(summary).toEqual({ summedServiceMs: 400, criticalPathMs: 100, entryCount: 3 });
  });
});

describe("useful output alongside cost", () => {
  it("divides the whole operation's spend by the claims it published", () => {
    const summary = summarizeUsefulOutput(
      outcome({
        claimsPublished: 4,
        modelCalls: 9,
        modelCallsReused: 3,
        firstPublishedAt: "2026-09-11T10:02:00.000Z",
      }),
      [
        entry({
          callSite: EXTRACTION,
          cost: { dollars: 0.004, estimated: false, unverified: false },
        }),
        entry({
          callSite: EVALUATION,
          cost: { dollars: 0.006, estimated: false, unverified: false },
        }),
      ],
    );

    expect(summary).toMatchObject({
      conclusion: "completed",
      claimsPublished: 4,
      modelCalls: 9,
      modelCallsReused: 3,
      firstPublishedAt: "2026-09-11T10:02:00.000Z",
    });
    expect(summary.totalDollars).toBeCloseTo(0.01, 10);
    expect(summary.dollarsPerPublishedClaim).toBeCloseTo(0.0025, 10);
  });

  it("reports no per-claim cost and no publication time when nothing was published", () => {
    const summary = summarizeUsefulOutput(outcome({ claimsPublished: 0, conclusion: "bounded" }), [
      entry(),
    ]);

    expect(summary).toMatchObject({
      conclusion: "bounded",
      claimsPublished: 0,
      modelCallsReused: 0,
      firstPublishedAt: null,
      dollarsPerPublishedClaim: null,
    });
    expect(summary.totalDollars).toBeCloseTo(0.001, 10);
  });
});

describe("the composed Person Profile cost summary", () => {
  it("filters every summary to the production call sites", () => {
    const entries = [
      entry({
        callSite: EXTRACTION,
        purpose: "personResearch",
        admittedAt: "2026-09-11T10:00:00.000Z",
        settledAt: "2026-09-11T10:00:00.100Z",
        cost: { dollars: 0.004, estimated: false, unverified: false },
        requestFingerprint: fingerprint("a"),
      }),
      entry({
        callSite: EXTRACTION,
        purpose: "personResearch",
        admittedAt: "2026-09-11T10:00:00.050Z",
        settledAt: "2026-09-11T10:00:00.150Z",
        cost: { dollars: 0.004, estimated: false, unverified: false },
        requestFingerprint: fingerprint("a"),
      }),
      entry({
        callSite: CLAIMS,
        purpose: "personResearch",
        admittedAt: "2026-09-11T10:00:30.000Z",
        settledAt: "2026-09-11T10:00:30.100Z",
        cost: { dollars: 0.002, estimated: false, unverified: false },
      }),
      entry({
        callSite: EVALUATION,
        purpose: "debriefEvaluation",
        admittedAt: "2026-09-11T10:00:45.000Z",
        settledAt: "2026-09-11T10:00:45.100Z",
        cost: { dollars: 0.01, estimated: false, unverified: false },
      }),
      entry({ admittedAt: "2026-09-11T10:01:00.000Z", settledAt: "2026-09-11T10:01:00.100Z" }),
    ];

    const summary = buildPersonProfileCostSummary(
      entries,
      outcome({ claimsPublished: 2, firstPublishedAt: "2026-09-11T10:01:05.000Z" }),
    );

    expect(summary.byCallSite).toEqual([
      {
        callSite: CLAIMS,
        purpose: "personResearch",
        calls: 1,
        dollars: 0.002,
        totalTokens: 120,
        cachedTokens: 0,
        exactRepeatCalls: 0,
      },
      {
        callSite: EXTRACTION,
        purpose: "personResearch",
        calls: 2,
        dollars: 0.008,
        totalTokens: 240,
        cachedTokens: 0,
        exactRepeatCalls: 1,
      },
    ]);
    /* Neither the evaluation charge nor the unattributed entry shapes the
       wall clock or the operation's spend: the whole report is the
       production three-site baseline, not only the by-call-site
       breakdown (#381). */
    expect(summary.criticalPath).toEqual({
      summedServiceMs: 300,
      criticalPathMs: 250,
      entryCount: 3,
    });
    expect(summary.usefulOutput).toMatchObject({
      conclusion: "completed",
      claimsPublished: 2,
      modelCalls: 5,
      modelCallsReused: 0,
      firstPublishedAt: "2026-09-11T10:01:05.000Z",
    });
    expect(summary.usefulOutput.totalDollars).toBeCloseTo(0.01, 10);
    expect(summary.usefulOutput.dollarsPerPublishedClaim).toBeCloseTo(0.005, 10);
  });
});
