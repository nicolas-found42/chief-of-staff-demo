import { z } from "zod/v3";
import { ModelBoundaryDiagnosticSchema, RESULT_SHAPE_BINDINGS } from "./llm.js";
import { ProviderIdSchema } from "./schemas.js";

/**
 * The Person Research Failure contract (issue #228).
 *
 * Production research and the benchmark evaluator record the same records, so
 * a developer debugging a benchmark miss reads the pipeline's own account of
 * what happened rather than an evaluation-side imitation of it.
 *
 * Three separations are load-bearing and are enforced by the shape rather
 * than by convention:
 *
 * - **Stage** (where the work stopped) is not **code** (what was observed).
 *   A 403 during retrieval is `stage: "access"`, `code: "http-error"`; it is
 *   not evidence that the page needs a login.
 * - **Observed** facts are not **hypotheses**. `cause` says which one this
 *   record is, and an unclassified failure stays `"unknown"` rather than
 *   receiving an invented explanation.
 * - An **attempt** is one try; `attemptOf` links a retry or a fallback to the
 *   attempt it is recovering, so a summary that shows the last line can never
 *   erase how the pipeline got there.
 */
export const PersonResearchStageSchema = z.enum([
  "discovery",
  "selection",
  "transport",
  "access",
  "rendering",
  "document-parsing",
  "caption-acquisition",
  "transcription",
  "identity",
  "extraction",
  "validation",
  "publication",
  "planning",
]);
export type PersonResearchStage = z.infer<typeof PersonResearchStageSchema>;

/**
 * Stable reason codes. They are the vocabulary a follow-up issue can name, so
 * they are added to rather than renamed. `unknown-cause` is deliberately
 * present: a failure the pipeline could not classify says so.
 */
export const PersonResearchFailureCodeSchema = z.enum([
  // Discovery and selection
  "discovery-refused",
  "discovery-empty",
  "selection-deferred",
  "duplicate-suppressed",
  "lead-rejected",
  // Transport and access
  "connectivity-failed",
  "dns-failed",
  "tls-failed",
  "request-timeout",
  "transport-failed",
  /**
   * The response body passed the collection cap before it could be read.
   * Separate from `transport-failed` because nothing about the network is
   * wrong: the source is simply larger than what a reader retains, so the
   * failure is deterministic and never worth a retry.
   */
  "source-too-large",
  "http-error",
  "rate-limited",
  "quota-exhausted",
  "login-required",
  "challenge-page",
  "resource-unavailable",
  /**
   * An archive answered with its own error or technical-difficulty page rather
   * than the capture, whatever status it used to do it (issue #253). Separate
   * from `resource-unavailable`, which is the archive saying it holds no
   * capture: one is a service fault to retry, the other a fact about coverage.
   */
  "archive-error-page",
  /**
   * A public record index answered HTTP 2xx with its own error or refusal
   * envelope rather than a record (issue #250). Like `archive-error-page`,
   * this is the index declining to serve the read — not a fact about
   * coverage, which stays `resource-unavailable`. The envelope is never
   * retained as text: it can echo the requested name, and no rights basis,
   * version or attribution would cover it.
   */
  "registry-error-envelope",
  "robots-excluded",
  // Rendering, parsing and media
  "rendering-failed",
  "unsupported-format",
  "parser-failed",
  "document-empty",
  "captions-missing",
  "transcription-failed",
  "runtime-unavailable",
  "subprocess-failed",
  // Downstream
  "ambiguous-attribution",
  "identity-unmatched",
  /** One claim withheld: its document is about a different individual (#409). */
  "off-subject-claim",
  "invalid-result-shape",
  "model-boundary-failed",
  "model-response-received",
  "unsupported-citation",
  "stale-result-rejected",
  "lifecycle-invalidated",
  "publication-conflict",
  // Recovery bookkeeping
  "retrieval-recovered",
  "model-call-metrics",
  /** An Extraction Part served from a validated checkpoint (#381); no call was made. */
  "model-call-reused",
  "unknown-cause",
]);
export type PersonResearchFailureCode = z.infer<typeof PersonResearchFailureCodeSchema>;

/** What the record's stated cause rests on. Never upgraded by a summary. */
export const PersonResearchCauseSchema = z.enum(["observed", "hypothesis", "unknown"]);
export type PersonResearchCause = z.infer<typeof PersonResearchCauseSchema>;

/**
 * Observations kept only where they were actually measured. Every field is
 * optional because inventing one (a token count the model boundary never
 * supplied, a status a thrown transport never produced) is the failure mode
 * this contract exists to prevent.
 */
export const PersonResearchObservationSchema = z.object({
  /** Upstream HTTP status, when a response was received at all. */
  status: z.number().int().optional(),
  /** The sanitized final URL after redirects. Never carries credentials. */
  finalUrl: z.string().max(4000).optional(),
  contentType: z.string().max(400).nullable().optional(),
  bytes: z.number().nonnegative().optional(),
  /** SHA-256 of the response or document body actually seen. */
  bodyHash: z.string().max(64).optional(),
  elapsedMilliseconds: z.number().nonnegative().optional(),
  /** Which deadline expired: the request, the render, or the subprocess. */
  timeoutStage: z.enum(["request", "render", "subprocess", "model"]).optional(),
  /** Where a parser gave up — a page number, an XPath-ish hint, a field path. */
  parserLocation: z.string().max(400).optional(),
  subprocessExitStatus: z.number().int().optional(),
  /** Readable model failure summary; never a response payload. */
  modelDiagnostic: z.string().max(2000).optional(),
  /** Classified, bounded shape observations supplied by the production model seam. */
  modelBoundary: ModelBoundaryDiagnosticSchema.optional(),
  retryAfterMilliseconds: z.number().nonnegative().optional(),
  /** A bounded, sanitized excerpt of what was actually received. */
  excerpt: z.string().max(2000).optional(),
  /** Wall time of one logical model call, measured by its caller. */
  modelCallDurationMilliseconds: z.number().nonnegative().optional(),
  /** Request text characters of one logical model call, measured by its caller. */
  modelInputCharacters: z.number().nonnegative().optional(),
  /** Answer characters of one logical model call, measured by its caller. */
  modelOutputCharacters: z.number().nonnegative().optional(),
  /** Tokens the wire reported for the succeeded attempt, when it named any. */
  modelUsageTokens: z
    .object({
      input: z.number().nonnegative().nullable(),
      output: z.number().nonnegative().nullable(),
    })
    .optional(),
});
export type PersonResearchObservation = z.infer<typeof PersonResearchObservationSchema>;

/**
 * One attempt at one piece of research work.
 *
 * `attemptOf` is the correlation key: the first attempt at a target sets it to
 * its own id, and every retry, alternative route and fallback repeats it. That
 * is what makes "which recovery worked" answerable from the stored history
 * instead of from log archaeology.
 */
export const PersonResearchAttemptSchema = z.object({
  id: z.string().max(64),
  /** The operation this attempt belongs to; stable for its whole lifetime. */
  operationId: z.string().max(64),
  /** Correlation id shared by an original attempt and all of its recoveries. */
  attemptOf: z.string().max(64),
  attempt: z.number().int().positive(),
  stage: PersonResearchStageSchema,
  code: PersonResearchFailureCodeSchema,
  outcome: z.enum(["failed", "recovered", "succeeded", "skipped"]),
  /** What further recovery, if any, this attempt led to. */
  recovery: z.enum(["retry", "alternative-route", "stopped", "recovered", "none"]),
  /** Why recovery stopped, when it did. Absent while recovery continues. */
  recoveryStopped: z.string().max(1000).optional(),
  cause: PersonResearchCauseSchema,
  /** The URL, query or record identity this attempt addressed. Sanitized. */
  target: z.string().max(4000),
  targetKind: z.enum(["query", "url", "record", "media", "document", "model", "profile"]),
  /** Which collector ran, and the version of it that produced this record. */
  collector: z.string().max(200),
  collectorVersion: z.string().max(80),
  /** Nonsecret configuration that changes the collector's behavior. */
  configuration: z.record(z.string().max(80), z.string().max(400)).optional(),
  observed: PersonResearchObservationSchema.optional(),
  /** One sentence naming what happened. Never asserts an unobserved cause. */
  reason: z.string().max(1000),
  /** What the failure cost: which source material or coverage went missing. */
  impact: z.string().max(1000).optional(),
  /** What a developer should do next. Concrete, not "investigate further". */
  remediation: z.string().max(1000).optional(),
  /** A suspected explanation, explicitly labeled as not established. */
  hypothesis: z.string().max(1000).optional(),
  occurredAt: z.string().max(40),
  /** The Person Profile revision live when this attempt ran. */
  profileRevision: z.number().int().nonnegative().optional(),
});
export type PersonResearchAttempt = z.infer<typeof PersonResearchAttemptSchema>;

/**
 * A lead: something the operation learned it could investigate.
 *
 * Completion is defined against this list, so a lead that was dropped has to
 * say why. "Finished the query list" is not a disposition; `deduplicated`,
 * `inaccessible` and `rejected` are, and each carries its reason.
 */
export const PersonResearchLeadSchema = z.object({
  id: z.string().max(64),
  kind: z.enum(["query", "url", "record", "media", "document"]),
  target: z.string().max(4000),
  resolvedUrl: z.string().max(4000).optional(),
  discoveryUrls: z.array(z.string().max(4000)).max(100).optional(),
  upstreamIndex: z.string().max(200).optional(),
  /** Where the lead came from: seed, a read document, or the planner. */
  origin: z.enum(["seed", "discovery", "document-link", "planner", "expansion"]),
  /** The source family this lead would exercise, when known. */
  family: z.string().max(120).optional(),
  /** Which coverage areas this lead was expected to serve. */
  coverage: z.array(z.string().max(80)).max(20).default([]),
  disposition: z.enum([
    "pending",
    "investigated",
    "rejected",
    "deduplicated",
    "inaccessible",
    "interrupted",
  ]),
  /** Why the lead has the disposition it has. Always populated once resolved. */
  reason: z.string().max(1000),
  /** Whether the investigation produced evidence retained in the dossier. */
  yieldedEvidence: z.boolean().default(false),
  /** Ranked selection score and the inputs that produced it. */
  selection: z
    .object({
      score: z.number().finite(),
      relevance: z.number().finite(),
      independence: z.number().finite(),
      coverageGap: z.number().finite(),
      efficiency: z.number().finite().optional(),
    })
    .optional(),
});
export type PersonResearchLead = z.infer<typeof PersonResearchLeadSchema>;

/**
 * One coverage area the operation planned to investigate. Areas are the
 * dossier's own sections plus the source families the spec names, so a
 * completion report says what was looked for, not only what was found.
 */
export const PersonResearchCoverageAreaSchema = z.object({
  key: z.string().max(80),
  label: z.string().max(200),
  kind: z.enum(["dossier-section", "source-family"]),
  state: z.enum(["planned", "investigated", "satisfied", "inaccessible", "interrupted"]),
  /** How many retained sources contributed evidence to this area. */
  sources: z.number().int().nonnegative(),
  /** How many published claims rest on it. */
  claims: z.number().int().nonnegative(),
  /** What remains unknown here. Explicit gaps, never an implied completeness. */
  gaps: z.array(z.string().max(1000)).max(20).default([]),
});
export type PersonResearchCoverageArea = z.infer<typeof PersonResearchCoverageAreaSchema>;

/** Why one continuous research operation stopped. */
export const PersonResearchConclusionSchema = z.enum([
  /** Coverage investigated, leads accounted for, expansion found nothing new. */
  "completed",
  /** A model outage, shutdown, cancellation or lifecycle change stopped it. */
  "interrupted",
  /** A hard bound (request ceiling, wall clock) stopped it with work pending. */
  "bounded",
]);
export type PersonResearchConclusion = z.infer<typeof PersonResearchConclusionSchema>;

/**
 * The states a Profile's queue job can be in. Named here, rather than only
 * inline on `PersonResearchJobSchema` (`packages/shared/src/person-dossier.ts`),
 * so the compact per-profile summary (issue #418, T5) can carry the same
 * vocabulary without importing back from a module that already imports this
 * one.
 */
export const PERSON_RESEARCH_JOB_STATES = [
  "queued",
  "researching",
  "paused",
  "incomplete",
  "unavailable",
  "interrupted",
  "empty",
  "current",
] as const;
export const PersonResearchJobStateSchema = z.enum(PERSON_RESEARCH_JOB_STATES);
export type PersonResearchJobState = z.infer<typeof PersonResearchJobStateSchema>;

/**
 * The stable, fact-derived classification of what a research operation's
 * extraction actually did (issue #418, T5, spec §7). Named apart from
 * {@link PersonResearchFailureCodeSchema} because a failure code says what one
 * attempt recorded; this says what the OPERATION concluded about extraction
 * overall, derived from the full attempt history rather than any one
 * message. `unusable_shape` alone never implies `no-usable-model-answer` was
 * caused by provider downtime or token exhaustion — the classification names
 * only the observed shape, not an unobserved cause.
 */
export const DecisiveExtractionClassificationSchema = z.enum([
  /** Extraction produced published claims; nothing decisive interrupted it. */
  "extraction-succeeded",
  /** The model boundary reported an empty answer where the binding expects one. */
  "no-usable-model-answer",
  /** The model's answer field held text that is not JSON. */
  "invalid-json",
  /** A parsed answer did not satisfy the dossier extraction schema. */
  "schema-validation-failed",
  /** Claims were withheld because their document could not be grounded to, or confirmed about, this subject. */
  "grounding-or-subject-withheld",
  /** Extraction validated successfully and found no facts to support. */
  "no-supported-facts",
  /** The request never reached the provider, or a transport-level failure answered instead. */
  "transport-failure",
  /** The operation's own lifecycle ended the work (shutdown, pause, Profile/evidence change). */
  "cancelled",
  /** A safety bound (requests, model calls, or wall clock) stopped the operation with work pending. */
  "safety-bound-exhausted",
  /** No attempt in this operation's history classifies the outcome. */
  "unknown",
]);
export type DecisiveExtractionClassification = z.infer<
  typeof DecisiveExtractionClassificationSchema
>;

/**
 * A durable, bounded summary of what decided one operation's extraction
 * outcome, stored WITH the operation and independent of its truncatable
 * attempt list (issue #418, T5, spec §7; #417 F3). `summarizeResearchAttempts`
 * bounds only a DISPLAY slice, and more than 40 unrelated identity/rendering
 * entries can crowd the decisive extraction failure out of it; this record is
 * computed once, from the operation's complete attempt history, and is never
 * subject to that display bound.
 */
export const DecisiveExtractionSummarySchema = z.object({
  operationId: z.string().max(64),
  profileId: z.string().max(160),
  /** Where the operation's extraction outcome was decided. */
  stage: PersonResearchStageSchema,
  /** The operation's own conclusion — completed, interrupted, or bounded. */
  disposition: PersonResearchConclusionSchema,
  classification: DecisiveExtractionClassificationSchema,
  /** What the classification rests on. Never upgraded by this summary. */
  cause: PersonResearchCauseSchema,
  /** The first attempt whose failure decided this outcome, when one exists. */
  firstFailure: z
    .object({
      code: PersonResearchFailureCodeSchema,
      stage: PersonResearchStageSchema,
      occurredAt: z.string().max(40),
      reason: z.string().max(300),
    })
    .optional(),
  /** Which model and binding produced the decisive attempt, when known. */
  model: z
    .object({
      provider: ProviderIdSchema,
      model: z.string().max(200),
      binding: z.enum(RESULT_SHAPE_BINDINGS),
    })
    .optional(),
  /** The finish reason the model boundary actually reported, when one was observed. */
  finishReason: z.string().max(200).nullable().optional(),
  /** Retries and alternative-route attempts behind the decisive outcome. */
  recoveryAttempts: z.number().int().nonnegative(),
  /** Extraction parts that answered and validated. */
  completedUnits: z.number().int().nonnegative(),
  /** Extraction parts that failed at the model boundary or schema validation. */
  incompleteUnits: z.number().int().nonnegative(),
  /** One sentence for a person reading the Profile. Derived from the facts above. */
  reason: z.string().max(300),
  recordedAt: z.string().max(40),
});
export type DecisiveExtractionSummary = z.infer<typeof DecisiveExtractionSummarySchema>;

/**
 * The outcome of one continuous research operation: what it covered, what it
 * could not reach, and every attempt behind both.
 */
export const PersonResearchOperationOutcomeSchema = z.object({
  operationId: z.string().max(64),
  profileId: z.string().max(160),
  conclusion: PersonResearchConclusionSchema,
  /** The interruption's own cause, when the conclusion is `interrupted`. */
  interruption: z
    .object({
      code: PersonResearchFailureCodeSchema,
      reason: z.string().max(1000),
    })
    .optional(),
  startedAt: z.string().max(40),
  finishedAt: z.string().max(40),
  /**
   * Absent only on operations recorded before this field existed (issue
   * #418, T5). Never recomputed retroactively from the truncatable attempt
   * list: historical missing provenance stays absent, not invented.
   */
  decisiveExtraction: DecisiveExtractionSummarySchema.optional(),
  /** Discovery passes, reading batches, and expansion rounds actually run. */
  rounds: z.number().int().nonnegative(),
  /** Logical model invocations; opted-in wire attempts are recorded in attempts. */
  modelCalls: z.number().int().nonnegative(),
  /**
   * Extraction Parts served from validated checkpoints instead of a model
   * call (issue #381, R1). Counted apart from `modelCalls`, never inside it:
   * a hit consumed no allowance and no wire charge.
   */
  modelCallsReused: z.number().int().nonnegative().optional(),
  requests: z.number().int().nonnegative(),
  /** Distinct source versions retained or reused by this operation, including unattempted versions. */
  sourcesRetained: z.number().int().nonnegative(),
  /** Absent on legacy outcomes whose exact retained-version identities were not recorded. */
  retainedSourceIds: z.array(z.string().length(64)).max(10000).optional(),
  claimsPublished: z.number().int().nonnegative(),
  /**
   * The wall-clock moment this operation first published anything, absent
   * when it never did. Paired with cost so a cheaper run that researches
   * less cannot read as a faster one to useful output (issue #381).
   */
  firstPublishedAt: z.string().max(40).optional(),
  /** The last dossier revision this operation published. */
  publishedDossierRevision: z.number().int().nonnegative().optional(),
  coverage: z.array(PersonResearchCoverageAreaSchema).max(80),
  leads: z.array(PersonResearchLeadSchema),
  attempts: z.array(PersonResearchAttemptSchema),
  /** Explicit remaining gaps. A completed operation still has these. */
  gaps: z.array(z.string().max(1000)).max(60),
  /** One sentence for the Profile reader. Never claims exhaustive search. */
  detail: z.string().max(2000),
});
export type PersonResearchOperationOutcome = z.infer<typeof PersonResearchOperationOutcomeSchema>;

/**
 * The compact view a Profile reader gets. It is derived, and it names how many
 * attempts it summarized, so a display limit is visibly a display limit rather
 * than the end of the record.
 */
export interface PersonResearchDiagnosticSummary {
  shown: PersonResearchAttempt[];
  totalAttempts: number;
  /** Attempt counts by code, across the whole history rather than the slice. */
  byCode: Record<string, number>;
}

export function summarizeResearchAttempts(
  attempts: PersonResearchAttempt[],
  limit = 20,
): PersonResearchDiagnosticSummary {
  const byCode: Record<string, number> = {};
  for (const attempt of attempts) byCode[attempt.code] = (byCode[attempt.code] ?? 0) + 1;
  /* Failures first, then the most recent: a summary that dropped the failure
     and kept the recovery would report a clean run that did not happen. */
  const ranked = [...attempts].sort((a, b) => {
    const weight = (entry: PersonResearchAttempt) => (entry.outcome === "failed" ? 0 : 1);
    return weight(a) - weight(b) || b.occurredAt.localeCompare(a.occurredAt);
  });
  return { shown: ranked.slice(0, limit), totalAttempts: attempts.length, byCode };
}

/**
 * Truthful readiness of the automatic/queued research pipeline itself
 * (issue #418, T3) — distinct from any one Profile's job state. A stable
 * `reason` code names *why*, and an optional `nextAction` is where an owner
 * goes to change it, matching the onboarding checklist's own `{label, href}`
 * shape (`api/onboarding.ts`).
 *
 * `initializing` is not evidence that setup is absent: it is the honest
 * answer while the Workspace or the owner's connected identity has not yet
 * produced a determinate read, and it is retryable. `setup-required` and
 * `disabled` are both terminal until an owner acts, but say different things:
 * the first names a step nobody has completed yet, the second names a
 * deliberate configuration (a non-production model provider) rather than an
 * incomplete one. `paused` is the owner's own explicit pause of the queue.
 */
export const PersonResearchReadinessStateSchema = z.enum([
  "initializing",
  "setup-required",
  "ready",
  "paused",
  "disabled",
]);
export type PersonResearchReadinessState = z.infer<typeof PersonResearchReadinessStateSchema>;

export const PersonResearchReadinessReasonSchema = z.enum([
  "workspace-initializing",
  "owner-identity-unresolved",
  "provider-not-configured",
  "owner-not-confirmed",
  "mock-provider-inactive",
  "administratively-paused",
  "ready",
]);
export type PersonResearchReadinessReason = z.infer<typeof PersonResearchReadinessReasonSchema>;

export const PersonResearchNextActionSchema = z.object({
  label: z.string().max(200),
  href: z.string().max(400),
});
export type PersonResearchNextAction = z.infer<typeof PersonResearchNextActionSchema>;

export const PersonResearchReadinessSchema = z.object({
  state: PersonResearchReadinessStateSchema,
  reason: PersonResearchReadinessReasonSchema,
  nextAction: PersonResearchNextActionSchema.optional(),
  /**
   * The connected Google email the owner confirmation is waiting on, present
   * only for `owner-not-confirmed` (UX audit F2): the gate copy names the
   * exact missing step — create a Profile carrying this email and confirm it
   * — instead of "an owner has not yet confirmed workspace setup".
   */
  ownerEmail: z.string().max(200).optional(),
});
export type PersonResearchReadiness = z.infer<typeof PersonResearchReadinessSchema>;

/**
 * What `PersonResearchQueue.enqueue()` actually decided (issue #418, T3),
 * replacing four silent no-op paths with one typed, exhaustive answer. An
 * `accepted` or `already-active` decision names the Profile and the job
 * state the caller can expect to observe; `rejected-readiness` carries the
 * same readiness a caller could otherwise only get by polling separately.
 */
export const PersonResearchEnqueueDecisionSchema = z.discriminatedUnion("kind", [
  /** A new or reactivated job now sits in the queue. */
  z.object({
    kind: z.literal("accepted"),
    profileId: z.string(),
    jobState: z.enum(["queued", "researching"]),
  }),
  /** Coalesced into a job already queued, researching, or paused. */
  z.object({
    kind: z.literal("already-active"),
    profileId: z.string(),
    jobState: z.enum(["queued", "researching", "paused"]),
  }),
  /** Not urgent, and the existing job's backoff window has not elapsed. */
  z.object({
    kind: z.literal("deferred"),
    profileId: z.string(),
    nextAt: z.string(),
  }),
  /** The pipeline itself is not ready to accept work right now. */
  z.object({
    kind: z.literal("rejected-readiness"),
    profileId: z.string(),
    readiness: PersonResearchReadinessSchema,
  }),
  /** The Profile does not exist, or is archived or merged away. */
  z.object({
    kind: z.literal("inactive-profile"),
    profileId: z.string(),
  }),
]);
export type PersonResearchEnqueueDecision = z.infer<typeof PersonResearchEnqueueDecisionSchema>;

/**
 * The hard serialized bounds the compact per-profile summary and its paged
 * diagnostic detail must respect (issue #418, T5, spec §7). Specification-
 * selected engineering bounds, not measured current performance.
 */
export const PERSON_RESEARCH_SUMMARY_MAX_BYTES = 16 * 1024;
export const PERSON_RESEARCH_DIAGNOSTICS_PAGE_SIZE = 50;

/** One bounded fact about an attempt, small enough to sample inside the summary itself. */
export const PersonResearchDiagnosticDigestSchema = z.object({
  code: PersonResearchFailureCodeSchema,
  stage: PersonResearchStageSchema,
  outcome: z.enum(["failed", "recovered", "succeeded", "skipped"]),
  occurredAt: z.string().max(40),
  reason: z.string().max(200),
});
export type PersonResearchDiagnosticDigest = z.infer<typeof PersonResearchDiagnosticDigestSchema>;

/**
 * Diagnostics aggregated by count, with a small bounded sample and a link to
 * the paged detail — never the full attempt ledger (spec §7). `truncated`
 * says the sample was cut for the 16 KiB summary budget, apart from and in
 * addition to `totalAttempts` already naming a display limit.
 */
export const PersonResearchDiagnosticsDigestSchema = z.object({
  totalAttempts: z.number().int().nonnegative(),
  byCode: z.record(z.string(), z.number().int().nonnegative()),
  /** Full-ledger matches of the legacy renderer-busy failure record, not a diagnosed cause. */
  rendererBusyReportedCount: z.number().int().nonnegative().optional(),
  sample: z.array(PersonResearchDiagnosticDigestSchema).max(8),
  truncated: z.boolean(),
  /** Where the paged, source-free detail for this operation can be read. */
  detailHref: z.string().max(200).optional(),
});
export type PersonResearchDiagnosticsDigest = z.infer<typeof PersonResearchDiagnosticsDigestSchema>;

/**
 * One page of an operation's attempt history (spec §7): at most
 * {@link PERSON_RESEARCH_DIAGNOSTICS_PAGE_SIZE} entries, source-free (an
 * attempt already carries only bounded structural facts), and linked to the
 * operation it belongs to.
 */
export const PersonResearchDiagnosticsPageSchema = z.object({
  operationId: z.string().max(64),
  profileId: z.string().max(160),
  entries: z.array(PersonResearchAttemptSchema).max(PERSON_RESEARCH_DIAGNOSTICS_PAGE_SIZE),
  totalAttempts: z.number().int().nonnegative(),
  /** Opaque offset into the operation's attempt history; absent on the last page. */
  nextCursor: z.string().max(40).nullable(),
});
export type PersonResearchDiagnosticsPage = z.infer<typeof PersonResearchDiagnosticsPageSchema>;

/**
 * A terminal conclusion superseded by a newer operation, kept as its own
 * labeled historical area rather than erased (spec §7, #417 F5): starting
 * operation B never presents operation A's conclusion as B's own.
 */
export const PersonResearchPreviousConclusionSchema = z.object({
  operationId: z.string().max(64),
  revision: z.number().int().nonnegative(),
  conclusion: PersonResearchConclusionSchema,
  finishedAt: z.string().max(40),
  detail: z.string().max(300),
  decisive: DecisiveExtractionSummarySchema.optional(),
});
export type PersonResearchPreviousConclusion = z.infer<
  typeof PersonResearchPreviousConclusionSchema
>;

/**
 * A compact immutable record of one concluded research operation, retained
 * queue-wide so a restart and later operations cannot erase it (#417 F8).
 * Deliberately bounded: no attempt ledger, leads, or checkpoint — the full
 * record stays on the operation outcome the job carried; this is the
 * identity, timing, conclusion, and one-sentence summary needed for unified
 * history. Old binaries strip it on their next save, which is acceptable:
 * rollback restores a quiesced baseline rather than re-writing new-format
 * state with an old binary.
 */
export const PersonResearchHistoryEntrySchema = z.object({
  profileId: z.string(),
  operationId: z.string().max(64),
  /** The dossier revision the operation settled at, when it published. */
  revision: z.number().int().nonnegative().optional(),
  startedAt: z.string().max(40),
  finishedAt: z.string().max(40),
  conclusion: PersonResearchConclusionSchema,
  detail: z.string().max(300),
  decisive: DecisiveExtractionSummarySchema.optional(),
});
export type PersonResearchHistoryEntry = z.infer<typeof PersonResearchHistoryEntrySchema>;

/**
 * The compact view of one Profile's research a normal poll reads (issue
 * #418, T5, spec §7). Built from the queue's named one-profile lookup, never
 * from `status()`'s whole-queue clone. Carries readiness, current state, the
 * in-flight operation's identity and revision (so live progress can never be
 * mistaken for an older generation's conclusion), bounded counters, the
 * durable decisive summary, and any superseded conclusion as its own labeled
 * history. Deliberately excludes retained text, other Profiles' jobs, the
 * full attempt ledger, visited-lead lists, and checkpoints. Serialized size
 * is bounded to {@link PERSON_RESEARCH_SUMMARY_MAX_BYTES}; `truncated` says
 * whether reaching that bound cost this instance any sample content.
 */
export const PersonResearchProfileSummarySchema = z.object({
  schemaVersion: z.literal(1),
  profileId: z.string().max(160),
  readiness: PersonResearchReadinessSchema,
  state: PersonResearchJobStateSchema,
  updatedAt: z.string().max(40),
  queuedAt: z.string().max(40),
  nextAt: z.string().max(40),
  attempts: z.number().int().nonnegative(),
  calls: z.number().int().nonnegative(),
  sources: z.number().int().nonnegative(),
  claimsPublished: z.number().int().nonnegative().optional(),
  /** The operation currently in flight, present only while `state` is `researching`. */
  currentOperationId: z.string().max(64).optional(),
  currentOperationRevision: z.number().int().nonnegative().optional(),
  /**
   * When the in-flight operation began (UX audit F7), so a waiting reader
   * sees elapsed time rather than a bare state word. Optional: absent while
   * no operation is in flight.
   */
  currentOperationStartedAt: z.string().max(40).optional(),
  /** The most recently settled operation's own revision, for comparison against `currentOperationRevision`. */
  operationRevision: z.number().int().nonnegative().optional(),
  stage: PersonResearchStageSchema.optional(),
  detail: z.string().max(300),
  decisive: DecisiveExtractionSummarySchema.optional(),
  previousConclusion: PersonResearchPreviousConclusionSchema.optional(),
  diagnostics: PersonResearchDiagnosticsDigestSchema,
  /** A small bounded sample of remaining gaps; the full list stays with the operation. */
  gaps: z.array(z.string().max(200)).max(10).optional(),
  truncated: z.boolean().optional(),
});
export type PersonResearchProfileSummary = z.infer<typeof PersonResearchProfileSummarySchema>;

/** The source families the expanded pipeline can exercise (issue #228). */
export const PERSON_SOURCE_FAMILIES = {
  "general-discovery": "General web discovery",
  "spoken-evidence": "Video, podcast and broadcast material",
  "public-social": "Public social posts and pages",
  "documents-publishers": "Documents, publisher sites and structured records",
  "published-work": "Published and deposited work",
  "professional-records": "Professional and institutional records",
  "creative-records": "Creative and cultural catalogue records",
  "identity-affiliation": "Identity and affiliation records",
  "historical-evidence": "Archived and historical evidence",
  workspace: "Workspace Transcripts confirmed for this person",
} as const;
export type PersonSourceFamily = keyof typeof PERSON_SOURCE_FAMILIES;
