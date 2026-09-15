import { expect, test } from "vitest";
import type {
  PersonResearchAttempt,
  PersonResearchJob,
  PersonResearchOperationOutcome,
  PersonResearchReadiness,
} from "@chief-of-staff-demo/shared";
import { summarizeResearchAttempts } from "@chief-of-staff-demo/shared";
import { modelBoundaryFailure } from "../../../apps/server/src/llm/failure.js";
import {
  buildProfileSummary,
  classifyDecisiveExtraction,
  describeExtractionBoundaryInterruption,
  fitToByteBudget,
  pagedDiagnostics,
} from "../../../apps/server/src/person-profile/research-summary.js";

const READY: PersonResearchReadiness = { state: "ready", reason: "ready" };

let sequence = 0;
function attempt(overrides: Partial<PersonResearchAttempt> = {}): PersonResearchAttempt {
  sequence += 1;
  return {
    id: `attempt-${String(sequence)}`,
    operationId: "op-1",
    attemptOf: `attempt-${String(sequence)}`,
    attempt: 1,
    stage: "discovery",
    code: "discovery-empty",
    outcome: "failed",
    recovery: "none",
    cause: "observed",
    target: "https://example.com",
    targetKind: "url",
    collector: "public-search",
    collectorVersion: "2026-09-06",
    reason: "Nothing decisive here.",
    occurredAt: new Date(2026, 8, 15, 12, 0, sequence).toISOString(),
    ...overrides,
  };
}

function operation(
  overrides: Partial<PersonResearchOperationOutcome> = {},
): PersonResearchOperationOutcome {
  return {
    operationId: "op-1",
    profileId: "person-1",
    conclusion: "completed",
    startedAt: "2026-09-15T00:00:00.000Z",
    finishedAt: "2026-09-15T00:05:00.000Z",
    rounds: 1,
    modelCalls: 1,
    requests: 1,
    sourcesRetained: 1,
    claimsPublished: 1,
    coverage: [],
    leads: [],
    attempts: [],
    gaps: [],
    detail: "Investigated the planned coverage.",
    ...overrides,
  };
}

test("more than 40 unrelated diagnostics cannot evict the decisive extraction cause", () => {
  const failure = modelBoundaryFailure({
    call: { provider: "openrouter", model: "inception/mercury-2.5", binding: "forced_tool_call" },
    classification: "unusable_shape",
    status: 200,
    payload: { choices: [{ message: {} }] },
    answer: { path: "choices.0.message", value: {} },
  });
  const decisive = attempt({
    stage: "extraction",
    code: "model-boundary-failed",
    outcome: "failed",
    target: "https://example.com/atlas",
    reason: "The model boundary failed.",
    observed: { modelBoundary: failure.diagnostic },
  });
  // 44 unrelated identity/rendering attempts, all more recent than the
  // decisive failure and all "failed" -- exactly the shape #417 F3 observed,
  // which crowds the decisive extraction failure out of the 40-entry display
  // slice `summarizeResearchAttempts` produces.
  const noise = Array.from({ length: 44 }, () =>
    attempt({ stage: "identity", code: "identity-unmatched", outcome: "failed" }),
  );
  const attempts = [decisive, ...noise];

  const displayed = summarizeResearchAttempts(attempts, 40);
  expect(displayed.shown.some((entry) => entry.id === decisive.id)).toBe(false);

  const summary = classifyDecisiveExtraction({
    operationId: "op-1",
    profileId: "person-1",
    conclusion: "interrupted",
    interruption: { code: "model-boundary-failed", reason: "extraction failed" },
    attempts,
    claimsPublished: 0,
    recordedAt: "2026-09-15T00:05:00.000Z",
  });
  expect(summary.classification).toBe("no-usable-model-answer");
  expect(summary.firstFailure?.code).toBe("model-boundary-failed");
  expect(summary.model).toMatchObject({ provider: "openrouter", model: "inception/mercury-2.5" });
});

test("distinguishes causes from observed facts, not message matching", () => {
  const boundary = (classification: Parameters<typeof modelBoundaryFailure>[0]["classification"]) =>
    modelBoundaryFailure({
      call: { provider: "openrouter", model: "m", binding: "forced_tool_call" },
      classification,
      status: 200,
      payload: {},
    }).diagnostic;

  const noAnswer = classifyDecisiveExtraction({
    operationId: "op",
    profileId: "p",
    conclusion: "interrupted",
    interruption: { code: "model-boundary-failed", reason: "x" },
    attempts: [
      attempt({
        stage: "extraction",
        code: "model-boundary-failed",
        observed: { modelBoundary: boundary("unusable_shape") },
      }),
    ],
    claimsPublished: 0,
    recordedAt: "now",
  });
  expect(noAnswer.classification).toBe("no-usable-model-answer");
  // #417 F2: an unusable_shape empty answer must never read as provider
  // downtime or token exhaustion.
  expect(noAnswer.reason.toLowerCase()).not.toContain("provider");
  expect(noAnswer.reason.toLowerCase()).not.toContain("token");

  const invalidJson = classifyDecisiveExtraction({
    operationId: "op",
    profileId: "p",
    conclusion: "interrupted",
    interruption: { code: "model-boundary-failed", reason: "x" },
    attempts: [
      attempt({
        stage: "extraction",
        code: "model-boundary-failed",
        observed: { modelBoundary: boundary("answer_not_json") },
      }),
    ],
    claimsPublished: 0,
    recordedAt: "now",
  });
  expect(invalidJson.classification).toBe("invalid-json");

  const transport = classifyDecisiveExtraction({
    operationId: "op",
    profileId: "p",
    conclusion: "interrupted",
    interruption: { code: "model-boundary-failed", reason: "x" },
    attempts: [
      attempt({
        stage: "extraction",
        code: "model-boundary-failed",
        observed: { modelBoundary: boundary("transport_failure") },
      }),
    ],
    claimsPublished: 0,
    recordedAt: "now",
  });
  expect(transport.classification).toBe("transport-failure");

  const schema = classifyDecisiveExtraction({
    operationId: "op",
    profileId: "p",
    conclusion: "interrupted",
    interruption: { code: "invalid-result-shape", reason: "x" },
    attempts: [attempt({ stage: "extraction", code: "invalid-result-shape" })],
    claimsPublished: 0,
    recordedAt: "now",
  });
  expect(schema.classification).toBe("schema-validation-failed");

  const cancelled = classifyDecisiveExtraction({
    operationId: "op",
    profileId: "p",
    conclusion: "interrupted",
    interruption: { code: "lifecycle-invalidated", reason: "x" },
    attempts: [],
    claimsPublished: 0,
    recordedAt: "now",
  });
  expect(cancelled.classification).toBe("cancelled");

  const bounded = classifyDecisiveExtraction({
    operationId: "op",
    profileId: "p",
    conclusion: "bounded",
    interruption: undefined,
    attempts: [],
    claimsPublished: 0,
    recordedAt: "now",
  });
  expect(bounded.classification).toBe("safety-bound-exhausted");

  const withheld = classifyDecisiveExtraction({
    operationId: "op",
    profileId: "p",
    conclusion: "completed",
    interruption: undefined,
    attempts: [
      attempt({
        stage: "extraction",
        code: "model-call-metrics",
        outcome: "succeeded",
      }),
      attempt({ stage: "identity", code: "off-subject-claim", outcome: "failed" }),
    ],
    claimsPublished: 0,
    recordedAt: "now",
  });
  expect(withheld.classification).toBe("grounding-or-subject-withheld");

  const noFacts = classifyDecisiveExtraction({
    operationId: "op",
    profileId: "p",
    conclusion: "completed",
    interruption: undefined,
    attempts: [attempt({ stage: "extraction", code: "model-call-metrics", outcome: "succeeded" })],
    claimsPublished: 0,
    recordedAt: "now",
  });
  // A valid Extraction with no supported facts is not confused with no
  // model answer.
  expect(noFacts.classification).toBe("no-supported-facts");

  const succeeded = classifyDecisiveExtraction({
    operationId: "op",
    profileId: "p",
    conclusion: "completed",
    interruption: undefined,
    attempts: [attempt({ stage: "extraction", code: "model-call-metrics", outcome: "succeeded" })],
    claimsPublished: 3,
    recordedAt: "now",
  });
  expect(succeeded.classification).toBe("extraction-succeeded");
});

test("describeExtractionBoundaryInterruption derives wording from the observed classification", () => {
  const emptyAnswer = describeExtractionBoundaryInterruption([
    attempt({
      stage: "extraction",
      code: "model-boundary-failed",
      observed: {
        modelBoundary: modelBoundaryFailure({
          call: { provider: "openrouter", model: "m", binding: "forced_tool_call" },
          classification: "unusable_shape",
          status: 200,
        }).diagnostic,
      },
    }),
  ]);
  expect(emptyAnswer.detail).toContain("no usable extraction answer");
  expect(emptyAnswer.detail).toContain("retained");
  expect(emptyAnswer.detail.toLowerCase()).not.toContain("provider failure");

  const unclassified = describeExtractionBoundaryInterruption([]);
  expect(unclassified.code).toBe("model-boundary-failed");
});

test("diagnostics are paged at 50 entries, cursor-linked, and named by their operation", () => {
  const attempts = Array.from({ length: 120 }, (_, index) =>
    attempt({ id: `attempt-${String(index)}`, attemptOf: `attempt-${String(index)}` }),
  );
  const op = operation({ attempts });

  const first = pagedDiagnostics(op);
  expect(first.entries).toHaveLength(50);
  expect(first.operationId).toBe(op.operationId);
  expect(first.profileId).toBe(op.profileId);
  expect(first.totalAttempts).toBe(120);
  expect(first.nextCursor).not.toBeNull();

  const second = pagedDiagnostics(op, first.nextCursor ?? undefined);
  expect(second.entries).toHaveLength(50);
  expect(second.nextCursor).not.toBeNull();

  const third = pagedDiagnostics(op, second.nextCursor ?? undefined);
  expect(third.entries).toHaveLength(20);
  expect(third.nextCursor).toBeNull();

  const seen = new Set([...first.entries, ...second.entries, ...third.entries].map((e) => e.id));
  expect(seen.size).toBe(120);
});

test("the per-profile summary stays at or below 16 KiB with large histories, many diagnostic codes, and multibyte strings", () => {
  const multibyte = "研究員が確認した内容はまだありません。".repeat(20) + "🧭".repeat(50);
  const codes: PersonResearchAttempt["code"][] = [
    "discovery-empty",
    "connectivity-failed",
    "dns-failed",
    "http-error",
    "rate-limited",
    "rendering-failed",
    "document-empty",
    "identity-unmatched",
    "off-subject-claim",
    "invalid-result-shape",
    "model-boundary-failed",
    "unsupported-citation",
  ];
  const attempts = Array.from({ length: 800 }, (_, index) =>
    attempt({
      id: `attempt-${String(index)}`,
      attemptOf: `attempt-${String(index)}`,
      code: codes[index % codes.length],
      reason: multibyte,
    }),
  );
  const decisive = classifyDecisiveExtraction({
    operationId: "op-big",
    profileId: "person-big",
    conclusion: "interrupted",
    interruption: { code: "model-boundary-failed", reason: multibyte },
    attempts,
    claimsPublished: 0,
    recordedAt: "2026-09-15T00:05:00.000Z",
  });
  const job: PersonResearchJob = {
    profileId: "person-big",
    state: "interrupted",
    reasons: ["explicit"],
    queuedAt: "2026-09-15T00:00:00.000Z",
    updatedAt: "2026-09-15T00:05:00.000Z",
    nextAt: "2026-09-15T01:00:00.000Z",
    calls: 12,
    sources: 40,
    attempts: 3,
    detail: multibyte,
    currentOperationId: "op-big",
    currentOperationRevision: 3,
    operationRevision: 3,
    operation: operation({
      operationId: "op-big",
      profileId: "person-big",
      conclusion: "interrupted",
      interruption: { code: "model-boundary-failed", reason: multibyte },
      decisiveExtraction: decisive,
      attempts,
      gaps: Array.from({ length: 60 }, () => multibyte),
    }),
    previousConclusion: {
      operationId: "op-old",
      revision: 2,
      conclusion: "interrupted",
      finishedAt: "2026-09-14T00:00:00.000Z",
      detail: multibyte,
      decisive: { ...decisive, operationId: "op-old" },
    },
  };
  const summary = buildProfileSummary({ job, readiness: READY });
  const bytes = Buffer.byteLength(JSON.stringify(summary), "utf8");
  expect(bytes).toBeLessThanOrEqual(16 * 1024);
  // Excluded entirely, never merely truncated: no queue-wide, ledger, or
  // checkpoint content leaks into the bounded summary -- the digest's own
  // aggregation is what keeps 800 attempts from ever reaching this size.
  expect(summary).not.toHaveProperty("checkpoint");
  expect(summary).not.toHaveProperty("leads");
  expect(JSON.stringify(summary)).not.toContain("visitedSourceIds");
});

test("fitToByteBudget truncates a summary that is still over budget after digesting", () => {
  const multibyte = "研究員が確認した内容はまだありません。".repeat(15);
  const byCode: Record<string, number> = {};
  for (let index = 0; index < 40; index += 1) byCode[`synthetic-code-${String(index)}`] = index + 1;
  const decisive = {
    operationId: "op-huge",
    profileId: "person-huge",
    stage: "extraction" as const,
    disposition: "interrupted" as const,
    classification: "no-usable-model-answer" as const,
    cause: "observed" as const,
    firstFailure: {
      code: "model-boundary-failed" as const,
      stage: "extraction" as const,
      occurredAt: "2026-09-15T00:00:00.000Z",
      reason: multibyte,
    },
    model: {
      provider: "openrouter" as const,
      model: multibyte.slice(0, 200),
      binding: "forced_tool_call" as const,
    },
    finishReason: multibyte.slice(0, 200),
    recoveryAttempts: 3,
    completedUnits: 0,
    incompleteUnits: 5,
    reason: multibyte,
    recordedAt: "2026-09-15T00:00:00.000Z",
  };
  const oversized = fitToByteBudget({
    schemaVersion: 1,
    profileId: "person-huge",
    readiness: READY,
    state: "interrupted",
    updatedAt: "2026-09-15T00:00:00.000Z",
    queuedAt: "2026-09-15T00:00:00.000Z",
    nextAt: "2026-09-15T01:00:00.000Z",
    attempts: 5,
    calls: 12,
    sources: 4,
    detail: multibyte,
    decisive,
    previousConclusion: {
      operationId: "op-old",
      revision: 1,
      conclusion: "interrupted",
      finishedAt: "2026-09-14T00:00:00.000Z",
      detail: multibyte,
      decisive: { ...decisive, operationId: "op-old" },
    },
    diagnostics: {
      totalAttempts: 900,
      byCode,
      sample: Array.from({ length: 8 }, () => ({
        code: "model-boundary-failed" as const,
        stage: "extraction" as const,
        outcome: "failed" as const,
        occurredAt: "2026-09-15T00:00:00.000Z",
        reason: multibyte,
      })),
      truncated: false,
      detailHref: "/api/people/person-huge/research/diagnostics",
    },
    gaps: Array.from({ length: 10 }, () => multibyte),
  });
  expect(Buffer.byteLength(JSON.stringify(oversized), "utf8")).toBeLessThanOrEqual(16 * 1024);
  expect(oversized.truncated).toBe(true);
  // A caller can still see there WAS a previous conclusion and what it
  // concluded, even after the shrink pipeline has cut its own decisive detail.
  expect(oversized.previousConclusion?.operationId).toBe("op-old");

  /* The digest exists to keep the codes that happened most, so the shrink
     keeps the head of the distribution and folds only the tail into `other`.
     Asserting the byte budget alone let the opposite ship: the tail was kept
     AND summed into `other`, so the commonest codes were dropped, every kept
     code was counted twice, and the map barely shrank. CodeRabbit caught it on
     #419; CODING_STANDARDS.md calls the shape of this miss out under "A test
     asserts the record, not only its summary". */
  const digested = oversized.diagnostics.byCode;
  /* `synthetic-code-N` was given count N+1, so 39 is the commonest and 0 the
     rarest. The commonest survives the digest; the rarest folds into `other`. */
  expect(digested).toHaveProperty("synthetic-code-39");
  expect(digested).not.toHaveProperty("synthetic-code-0");
  const kept = Object.entries(digested)
    .filter(([code]) => code !== "other")
    .map(([, count]) => count);
  const other = digested.other;
  /* Every kept code is commoner than everything folded away. Comparing the
     least kept against the GLOBAL minimum would pass even if a rare code had
     displaced a commoner one, so the comparison is against the folded set's
     own maximum. */
  const retainedCodes = new Set(Object.keys(digested).filter((code) => code !== "other"));
  const folded = Object.entries(byCode)
    .filter(([code]) => !retainedCodes.has(code))
    .map(([, count]) => count);
  expect(Math.min(...kept)).toBeGreaterThan(Math.max(...folded));
  /* Nothing is counted twice: each original count lands in exactly one of a
     kept entry or `other`. */
  const total = Object.values(byCode).reduce((sum, n) => sum + n, 0);
  expect(kept.reduce((sum, n) => sum + n, 0) + other).toBe(total);
});

test("fitToByteBudget is a no-op under budget and idempotent once it has shrunk", () => {
  const job: PersonResearchJob = {
    profileId: "person-1",
    state: "current",
    reasons: ["created"],
    queuedAt: "2026-09-15T00:00:00.000Z",
    updatedAt: "2026-09-15T00:05:00.000Z",
    nextAt: "2026-09-22T00:00:00.000Z",
    calls: 1,
    sources: 1,
    attempts: 1,
    detail: "Investigated the planned coverage.",
    operation: operation(),
  };
  const summary = buildProfileSummary({ job, readiness: READY });
  expect(summary.truncated).toBeUndefined();
  expect(fitToByteBudget(summary)).toEqual(summary);
});
