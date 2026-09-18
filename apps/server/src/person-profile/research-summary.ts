import {
  PERSON_RESEARCH_DIAGNOSTICS_PAGE_SIZE,
  PERSON_RESEARCH_SUMMARY_MAX_BYTES,
  type DecisiveExtractionClassification,
  type DecisiveExtractionSummary,
  type ModelBoundaryClassification,
  type PersonResearchAttempt,
  type PersonResearchCause,
  type PersonResearchConclusion,
  type PersonResearchDiagnosticsDigest,
  type PersonResearchDiagnosticsPage,
  type PersonResearchFailureCode,
  type PersonResearchJob,
  type PersonResearchOperationOutcome,
  type PersonResearchProfileSummary,
  type PersonResearchReadiness,
} from "@chief-of-staff-demo/shared";

/**
 * Derives the durable decisive-extraction summary for one operation (issue
 * #418, T5, spec §7) from its complete attempt history — never from the
 * truncatable display slice `summarizeResearchAttempts` produces. Wording is
 * built from the facts each branch actually observed: an `unusable_shape` or
 * `empty_body` model-boundary classification never becomes "provider
 * downtime" or "token exhaustion" here, only "the model returned no usable
 * extraction answer."
 */
export function classifyDecisiveExtraction(input: {
  operationId: string;
  profileId: string;
  conclusion: PersonResearchConclusion;
  interruption: { code: PersonResearchFailureCode; reason: string } | undefined;
  /** The operation's complete attempt history — unbounded, never the 40-entry display slice. */
  attempts: PersonResearchAttempt[];
  claimsPublished: number;
  recordedAt: string;
}): DecisiveExtractionSummary {
  const extractionAttempts = input.attempts.filter((attempt) => attempt.stage === "extraction");
  const failedExtraction = extractionAttempts.filter((attempt) => attempt.outcome === "failed");
  const succeededExtraction = extractionAttempts.filter(
    (attempt) =>
      attempt.outcome === "succeeded" &&
      (attempt.code === "model-call-metrics" || attempt.code === "model-call-reused"),
  );
  const withheldForSubject = input.attempts.filter(
    (attempt) =>
      attempt.code === "off-subject-claim" ||
      (attempt.code === "identity-unmatched" && attempt.outcome === "failed"),
  );
  const recoveryAttempts = input.attempts.filter((attempt) => attempt.attempt > 1).length;
  const completedUnits = succeededExtraction.length;
  const incompleteUnits = failedExtraction.length;

  const decisiveAttempt = failedExtraction[0];
  const boundary = decisiveAttempt?.observed?.modelBoundary;
  const firstFailure = decisiveAttempt
    ? {
        code: decisiveAttempt.code,
        stage: decisiveAttempt.stage,
        occurredAt: decisiveAttempt.occurredAt,
        reason: decisiveAttempt.reason.slice(0, 300),
      }
    : undefined;
  const model = boundary
    ? { provider: boundary.provider, model: boundary.model, binding: boundary.binding }
    : undefined;
  const finishReason = boundary?.finishReason;

  const NO_ANSWER = new Set<ModelBoundaryClassification>(["unusable_shape", "empty_body"]);
  const INVALID_JSON = new Set<ModelBoundaryClassification>([
    "answer_not_json",
    "unparseable_body",
  ]);
  const TRANSPORT = new Set<ModelBoundaryClassification>([
    "transport_failure",
    "http_error",
    "upstream_error",
    "request_timeout",
  ]);

  let classification: DecisiveExtractionClassification;
  let cause: PersonResearchCause;
  let reason: string;

  if (input.conclusion === "interrupted" && input.interruption?.code === "lifecycle-invalidated") {
    classification = "cancelled";
    cause = "observed";
    reason =
      "The operation's own lifecycle ended the work before extraction finished; retained evidence and pending work are preserved.";
  } else if (boundary && NO_ANSWER.has(boundary.classification)) {
    classification = "no-usable-model-answer";
    cause = "observed";
    reason =
      "The model returned no usable extraction answer; retained evidence is preserved and pending work continues.";
  } else if (boundary && INVALID_JSON.has(boundary.classification)) {
    classification = "invalid-json";
    cause = "observed";
    reason = "The model's extraction answer was not valid JSON; retained evidence is preserved.";
  } else if (boundary && TRANSPORT.has(boundary.classification)) {
    classification = "transport-failure";
    cause = "observed";
    reason =
      "A transport or provider-side failure interrupted extraction; retained evidence is preserved.";
  } else if (decisiveAttempt?.code === "invalid-result-shape") {
    classification = "schema-validation-failed";
    cause = "observed";
    reason =
      "The model answered, but its reply did not satisfy the dossier extraction schema; retained evidence is preserved.";
  } else if (boundary) {
    classification = "unknown";
    cause = "unknown";
    reason =
      "Extraction failed at the model boundary for a reason this build does not classify further; retained evidence is preserved.";
  } else if (input.conclusion === "bounded" && incompleteUnits === 0) {
    classification = "safety-bound-exhausted";
    cause = "observed";
    reason =
      "A safety bound stopped the operation with work still pending; retained evidence and pending leads are preserved.";
  } else if (input.claimsPublished === 0 && withheldForSubject.length > 0 && completedUnits > 0) {
    classification = "grounding-or-subject-withheld";
    cause = "observed";
    reason =
      "Extraction ran, but every candidate claim was withheld because its document could not be grounded to this subject.";
  } else if (input.claimsPublished === 0 && completedUnits > 0) {
    classification = "no-supported-facts";
    cause = "observed";
    reason =
      "Extraction validated successfully and found no facts it could support about this person.";
  } else if (input.claimsPublished > 0) {
    classification = "extraction-succeeded";
    cause = "observed";
    reason = "Extraction published grounded claims; nothing decisive interrupted it.";
  } else {
    classification = "unknown";
    cause = "unknown";
    reason = "No attempt in this operation's history classifies its extraction outcome.";
  }

  return {
    operationId: input.operationId,
    profileId: input.profileId,
    stage: decisiveAttempt?.stage ?? (input.claimsPublished > 0 ? "publication" : "extraction"),
    disposition: input.conclusion,
    classification,
    cause,
    ...(firstFailure ? { firstFailure } : {}),
    ...(model ? { model } : {}),
    ...(finishReason !== undefined ? { finishReason } : {}),
    recoveryAttempts,
    completedUnits,
    incompleteUnits,
    reason,
    recordedAt: input.recordedAt,
  };
}

/**
 * Honest wording for the interruption `run()` raises when extraction has
 * failed repeatedly with no success to reset against (issue #418, T5, spec
 * §7; #417 F2). The prior text asserted "Model-provider failure interrupted
 * research" unconditionally — an `unusable_shape` empty answer is not
 * evidence the provider was down, and this derives its wording from the
 * actual observed model-boundary classification instead of guessing one.
 */
export function describeExtractionBoundaryInterruption(attempts: PersonResearchAttempt[]): {
  code: PersonResearchFailureCode;
  /** The failing attempt's own diagnostic sentence. */
  codeReason: string;
  /** The operation-level detail a Profile reader sees. */
  detail: string;
} {
  const lastFailure = [...attempts]
    .reverse()
    .find((attempt) => attempt.stage === "extraction" && attempt.outcome === "failed");
  const boundary = lastFailure?.observed?.modelBoundary;
  const TRANSPORT: ModelBoundaryClassification[] = [
    "transport_failure",
    "http_error",
    "upstream_error",
    "request_timeout",
  ];
  if (
    boundary &&
    (boundary.classification === "unusable_shape" || boundary.classification === "empty_body")
  ) {
    const detail =
      "The model returned no usable extraction answer; retrieved evidence and pending work are retained.";
    return { code: "model-boundary-failed", codeReason: detail, detail };
  }
  if (
    boundary &&
    (boundary.classification === "answer_not_json" ||
      boundary.classification === "unparseable_body")
  ) {
    const detail =
      "The model's extraction answer was not valid JSON; retrieved evidence and pending work are retained.";
    return { code: "model-boundary-failed", codeReason: detail, detail };
  }
  if (boundary && TRANSPORT.includes(boundary.classification)) {
    const detail =
      "A transport or provider-side failure interrupted extraction; retrieved evidence and pending work are retained.";
    return { code: "model-boundary-failed", codeReason: detail, detail };
  }
  const detail =
    "Extraction repeatedly failed at the model boundary; retrieved evidence and pending work are retained.";
  return { code: "model-boundary-failed", codeReason: detail, detail };
}

/**
 * One page of an operation's full attempt ledger (spec §7): bounded to
 * {@link PERSON_RESEARCH_DIAGNOSTICS_PAGE_SIZE} entries, offset-cursored, and
 * always named by the operation it came from. Attempts are already
 * source-free structural facts (`PersonResearchAttemptSchema` never carries
 * retained text), so no further stripping happens here.
 */
export function pagedDiagnostics(
  operation: PersonResearchOperationOutcome,
  cursor?: string,
): PersonResearchDiagnosticsPage {
  const parsedOffset = cursor === undefined ? 0 : Number.parseInt(cursor, 10);
  const offset = Number.isFinite(parsedOffset) && parsedOffset > 0 ? parsedOffset : 0;
  const entries = operation.attempts.slice(offset, offset + PERSON_RESEARCH_DIAGNOSTICS_PAGE_SIZE);
  const nextOffset = offset + entries.length;
  return {
    operationId: operation.operationId,
    profileId: operation.profileId,
    entries,
    totalAttempts: operation.attempts.length,
    nextCursor: nextOffset < operation.attempts.length ? String(nextOffset) : null,
  };
}

const DIAGNOSTIC_SAMPLE_SIZE = 5;

/** Counts and a small bounded sample, ranked failures-first like the existing display slice. */
function digestDiagnostics(
  attempts: PersonResearchAttempt[],
  detailHref: string,
): PersonResearchDiagnosticsDigest {
  const byCode: Record<string, number> = {};
  let rendererBusyReportedCount = 0;
  for (const attempt of attempts) {
    byCode[attempt.code] = (byCode[attempt.code] ?? 0) + 1;
    // Legacy attempts have no typed renderer failure cause. Count only the
    // known record emitted by the anonymous renderer catch, including its
    // doubled punctuation; this reports what it said, not a saturation diagnosis.
    if (
      attempt.stage === "rendering" &&
      attempt.code === "rendering-failed" &&
      attempt.outcome === "failed" &&
      attempt.cause === "observed" &&
      attempt.collector === "browser-renderer" &&
      attempt.reason ===
        "The anonymous browser route failed: Browser source renderer is busy; retry later.."
    )
      rendererBusyReportedCount += 1;
  }
  const ranked = [...attempts].sort((a, b) => {
    const weight = (entry: PersonResearchAttempt) => (entry.outcome === "failed" ? 0 : 1);
    return weight(a) - weight(b) || b.occurredAt.localeCompare(a.occurredAt);
  });
  const sample = ranked.slice(0, DIAGNOSTIC_SAMPLE_SIZE).map((attempt) => ({
    code: attempt.code,
    stage: attempt.stage,
    outcome: attempt.outcome,
    occurredAt: attempt.occurredAt,
    reason: attempt.reason.slice(0, 200),
  }));
  return {
    totalAttempts: attempts.length,
    byCode,
    rendererBusyReportedCount,
    sample,
    truncated: attempts.length > sample.length,
    detailHref,
  };
}

/**
 * The compact per-profile summary a normal poll reads (issue #418, T5, spec
 * §7), built from the queue's named one-profile lookup (`job(profileId)`)
 * rather than `status()`'s whole-queue clone. Enforces the 16 KiB hard limit
 * itself via {@link fitToByteBudget}, so the bound holds regardless of how
 * large the underlying job/operation grew.
 */
export function buildProfileSummary(input: {
  job: PersonResearchJob;
  readiness: PersonResearchReadiness;
}): PersonResearchProfileSummary {
  const { job } = input;
  const operation = job.operation;
  const attempts = operation?.attempts ?? [];
  const detailHref = `/api/people/${job.profileId}/research/diagnostics`;
  const decisive = operation?.decisiveExtraction;
  const summary: PersonResearchProfileSummary = {
    schemaVersion: 1,
    profileId: job.profileId,
    readiness: input.readiness,
    state: job.state,
    updatedAt: job.updatedAt,
    queuedAt: job.queuedAt,
    nextAt: job.nextAt,
    attempts: job.attempts,
    calls: job.calls,
    sources: job.sources,
    ...(operation ? { claimsPublished: operation.claimsPublished } : {}),
    ...(job.currentOperationId ? { currentOperationId: job.currentOperationId } : {}),
    ...(job.currentOperationRevision !== undefined
      ? { currentOperationRevision: job.currentOperationRevision }
      : {}),
    ...(job.operationRevision !== undefined ? { operationRevision: job.operationRevision } : {}),
    ...(decisive ? { stage: decisive.stage } : {}),
    detail: job.detail.slice(0, 300),
    ...(decisive ? { decisive } : {}),
    ...(job.previousConclusion ? { previousConclusion: job.previousConclusion } : {}),
    diagnostics: digestDiagnostics(attempts, detailHref),
    ...(operation?.gaps.length
      ? { gaps: operation.gaps.slice(0, 10).map((gap) => gap.slice(0, 200)) }
      : {}),
  };
  return fitToByteBudget(summary);
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function capByCode(byCode: Record<string, number>, maxEntries: number): Record<string, number> {
  const entries = Object.entries(byCode).sort((a, b) => b[1] - a[1]);
  if (entries.length <= maxEntries) return byCode;
  const overflow = entries.slice(maxEntries).reduce((sum, [, count]) => sum + count, 0);
  return { ...Object.fromEntries(entries.slice(0, maxEntries)), other: overflow };
}

/**
 * Enforces {@link PERSON_RESEARCH_SUMMARY_MAX_BYTES} deterministically,
 * regardless of adversarial content (many diagnostic codes, long multibyte
 * strings, a large previous-conclusion history). Each step trades away less
 * essential content first and marks `truncated: true` once anything is cut,
 * so a caller never mistakes a bounded view for the complete record.
 */
export function fitToByteBudget(input: PersonResearchProfileSummary): PersonResearchProfileSummary {
  let summary = input;
  if (byteLength(summary) <= PERSON_RESEARCH_SUMMARY_MAX_BYTES) return summary;

  if (summary.diagnostics.sample.length > 0) {
    summary = { ...summary, diagnostics: { ...summary.diagnostics, sample: [] }, truncated: true };
  }
  if (byteLength(summary) > PERSON_RESEARCH_SUMMARY_MAX_BYTES) {
    summary = {
      ...summary,
      diagnostics: { ...summary.diagnostics, byCode: capByCode(summary.diagnostics.byCode, 5) },
      truncated: true,
    };
  }
  if (byteLength(summary) > PERSON_RESEARCH_SUMMARY_MAX_BYTES && summary.gaps) {
    const { gaps: _gaps, ...withoutGaps } = summary;
    summary = { ...withoutGaps, truncated: true };
  }
  if (byteLength(summary) > PERSON_RESEARCH_SUMMARY_MAX_BYTES && summary.decisive) {
    summary = {
      ...summary,
      decisive: {
        ...summary.decisive,
        reason: summary.decisive.reason.slice(0, 80),
        ...(summary.decisive.firstFailure
          ? {
              firstFailure: {
                ...summary.decisive.firstFailure,
                reason: summary.decisive.firstFailure.reason.slice(0, 80),
              },
            }
          : {}),
      },
      truncated: true,
    };
  }
  if (
    byteLength(summary) > PERSON_RESEARCH_SUMMARY_MAX_BYTES &&
    summary.previousConclusion?.decisive
  ) {
    const { decisive: _decisive, ...withoutDecisive } = summary.previousConclusion;
    summary = {
      ...summary,
      previousConclusion: { ...withoutDecisive, detail: withoutDecisive.detail.slice(0, 80) },
      truncated: true,
    };
  }
  if (byteLength(summary) > PERSON_RESEARCH_SUMMARY_MAX_BYTES) {
    summary = { ...summary, detail: summary.detail.slice(0, 80), truncated: true };
  }
  if (byteLength(summary) > PERSON_RESEARCH_SUMMARY_MAX_BYTES && summary.previousConclusion) {
    summary = {
      ...summary,
      previousConclusion: {
        operationId: summary.previousConclusion.operationId,
        revision: summary.previousConclusion.revision,
        conclusion: summary.previousConclusion.conclusion,
        finishedAt: summary.previousConclusion.finishedAt,
        detail: "Truncated to fit the summary size bound.",
      },
      truncated: true,
    };
  }
  return summary;
}
