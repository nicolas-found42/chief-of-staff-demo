import { z } from "zod/v3";

/**
 * The private validation-campaign record (#363, MWR-017/019/020/021/022/057).
 *
 * A campaign is a frozen plan and an append-only outcome log: the manifest is
 * written before the first dispatch and never rewritten, every planned slot
 * ends with exactly one terminal outcome, and the summary measures only what
 * the record holds. None of these shapes carries transcript text or model
 * output; the artifacts stay beside the record under their slot's cold root.
 */

export const CAMPAIGN_PROTOCOLS = ["baseline", "comparison", "final", "brief"] as const;
export const CampaignProtocolSchema = z.enum(CAMPAIGN_PROTOCOLS);
export type CampaignProtocol = z.infer<typeof CampaignProtocolSchema>;

export const CAMPAIGN_SLOT_KINDS = ["golden", "incident", "brief"] as const;
export const CampaignSlotKindSchema = z.enum(CAMPAIGN_SLOT_KINDS);
export type CampaignSlotKind = z.infer<typeof CampaignSlotKindSchema>;

/**
 * Terminal outcomes. `missing` is a recorded outcome too: a slot the run never
 * produced is reported with its reason, never dropped from the denominator.
 * `interrupted` is a slot whose operation began and did not finish.
 */
export const CAMPAIGN_TERMINAL_STATUSES = [
  "success",
  "schema-invalid",
  "failed",
  "interrupted",
  "missing",
] as const;
export const CampaignTerminalStatusSchema = z.enum(CAMPAIGN_TERMINAL_STATUSES);
export type CampaignTerminalStatus = z.infer<typeof CampaignTerminalStatusSchema>;

/**
 * The frozen corpus revision a campaign ran against: the case ids that existed
 * at freeze time and a content hash over their bytes. Slot counts derive from
 * this, never from a constant.
 */
export const CampaignCorpusRevisionSchema = z.object({
  revision: z.string().min(1),
  goldenCaseIds: z.array(z.string().min(1)),
  incidentCaseIds: z.array(z.string().min(1)),
  briefCaseIds: z.array(z.string().min(1)).default([]),
});
export type CampaignCorpusRevision = z.infer<typeof CampaignCorpusRevisionSchema>;

/**
 * One development model route, frozen before dispatch. The grant is named by
 * identity only — its policy is verified at dispatch and never copied here.
 */
export const CampaignModelRouteSchema = z.object({
  model: z.string().min(1),
  route: z.string().min(1),
  binding: z.string().min(1),
  grantId: z.string().min(1).nullable(),
});
export type CampaignModelRoute = z.infer<typeof CampaignModelRouteSchema>;

export const CampaignFreezeFactsSchema = z.object({
  /** Source revision the harness ran from. */
  codeRevision: z.string().min(1),
  /** Hash of the uncommitted diff, or `clean` when the checkout had none. */
  diffHash: z.string().min(1),
  /** Running image identity, or `local-process` outside a container. */
  imageDigest: z.string().min(1),
  /** Hash over the identity/context the harness feeds every record. */
  sourceContextHash: z.string().min(1),
  /** Hash over the resolved extraction prompt and result-shape schema. */
  promptHash: z.string().min(1),
  schemaHash: z.string().min(1),
  /** The extractor strategy/validator label the runs record. */
  validatorVersion: z.string().min(1),
  corpus: CampaignCorpusRevisionSchema,
  models: z.array(CampaignModelRouteSchema).min(1),
  campaignBudgetDollars: z.number().min(0),
  operationBudgetDollars: z.number().min(0),
  /** Parent of every slot's cold root; a slot root is never reused. */
  coldRoot: z.string().min(1),
});
export type CampaignFreezeFacts = z.infer<typeof CampaignFreezeFactsSchema>;

export const CampaignSlotSchema = z.object({
  slotId: z.string().min(1),
  protocol: CampaignProtocolSchema,
  kind: CampaignSlotKindSchema,
  caseId: z.string().min(1),
  model: z.string().min(1),
  /** Extractor arm label; a single-extractor protocol has one arm. */
  arm: z.string().min(1),
  repetition: z.number().int().min(1),
  /** A cold slot starts with empty/disabled request checkpoints and a fresh root. */
  cold: z.boolean(),
  root: z.string().min(1),
  /** The budget ledger operation this slot's calls are charged to. */
  operationId: z.string().min(1),
});
export type CampaignSlot = z.infer<typeof CampaignSlotSchema>;

export const CampaignManifestSchema = z.object({
  manifestVersion: z.literal(1),
  campaignId: z.string().min(1),
  protocol: CampaignProtocolSchema,
  createdAt: z.string().min(1),
  freeze: CampaignFreezeFactsSchema,
  slots: z.array(CampaignSlotSchema).min(1),
  /** sha256 over canonical JSON of the manifest without this field. */
  digest: z.string().length(64),
});
export type CampaignManifest = z.infer<typeof CampaignManifestSchema>;

export const ValidationSlotOutcomeSchema = z.object({
  slotId: z.string().min(1),
  status: CampaignTerminalStatusSchema,
  /** Why this outcome is what it is; bounded and never transcript text. */
  reason: z.string().max(2000).nullable(),
  /** Logical invocations this slot made. */
  attempts: z.number().int().min(0),
  /** Wire attempts charged to the operation, retries and repairs included. */
  chargedAttempts: z.number().int().min(0),
  retries: z.number().int().min(0),
  queueDelayMs: z.number().int().min(0),
  processingMs: z.number().int().min(0),
  totalMs: z.number().int().min(0),
  costDollars: z.number().min(0),
  costEstimated: z.boolean(),
  costUnverified: z.boolean(),
  artifactPath: z.string().min(1).nullable(),
  recordedAt: z.string().min(1),
});
export type ValidationSlotOutcome = z.infer<typeof ValidationSlotOutcomeSchema>;

/** A deterministic Golden verdict, kept apart from any human judgment. */
export const CampaignGoldenScoreSchema = z.object({
  slotId: z.string().min(1),
  golden: z.string().min(1),
  passed: z.boolean(),
  failures: z.array(z.string()).default([]),
  scoredAt: z.string().min(1),
});
export type CampaignGoldenScore = z.infer<typeof CampaignGoldenScoreSchema>;

/**
 * A privately retained blind human judgment (MWR-022). Blind means the
 * adjudicator saw produced output and expectations, never the model identity;
 * this is a different evidence class from a deterministic Golden score.
 */
export const CampaignHumanJudgmentSchema = z.object({
  judgmentId: z.string().min(1),
  campaignId: z.string().min(1),
  slotId: z.string().min(1),
  adjudicator: z.string().min(1),
  blinded: z.literal(true),
  adjudicatedAt: z.string().min(1),
  counts: z.object({
    falseActions: z.number().int().min(0),
    missedActions: z.number().int().min(0),
    wrongResponsibility: z.number().int().min(0),
    wrongDates: z.number().int().min(0),
    wrongMerges: z.number().int().min(0),
    falseDecisions: z.number().int().min(0),
    unsupportedHandoffDetails: z.number().int().min(0),
    producedActions: z.number().int().min(0),
    expectedObligations: z.number().int().min(0),
    responsibilityAssertions: z.number().int().min(0),
    interpretedDates: z.number().int().min(0),
    mergeDecisions: z.number().int().min(0),
    producedDecisions: z.number().int().min(0),
    assessedDetails: z.number().int().min(0),
  }),
});
export type CampaignHumanJudgment = z.infer<typeof CampaignHumanJudgmentSchema>;

/** The measured semantic categories of MWR-021, each with its own denominator. */
export const CAMPAIGN_SEMANTIC_CATEGORIES = [
  "false-actions-per-produced-action",
  "missed-actions-per-expected-obligation",
  "wrong-responsibility-per-assertion",
  "wrong-dates-per-interpreted-date",
  "wrong-merges-per-merge-decision",
  "false-decisions-per-produced-decision",
  "unsupported-handoff-details-per-assessed-detail",
] as const;
export const CampaignSemanticCategorySchema = z.enum(CAMPAIGN_SEMANTIC_CATEGORIES);
export type CampaignSemanticCategory = z.infer<typeof CampaignSemanticCategorySchema>;

export const CampaignSemanticCountSchema = z.object({
  category: CampaignSemanticCategorySchema,
  numerator: z.number().int().min(0),
  denominator: z.number().int().min(0),
  /** False when the denominator is zero: not applicable, never a perfect rate. */
  applicable: z.boolean(),
  rate: z.number().min(0).nullable(),
});
export type CampaignSemanticCount = z.infer<typeof CampaignSemanticCountSchema>;

export const CampaignSlotReportRowSchema = z.object({
  index: z.number().int().min(0),
  slotId: z.string().min(1),
  kind: CampaignSlotKindSchema,
  model: z.string().min(1),
  arm: z.string().min(1),
  repetition: z.number().int().min(1),
  cold: z.boolean(),
  status: CampaignTerminalStatusSchema,
  reason: z.string().nullable(),
  attempts: z.number().int().min(0),
  chargedAttempts: z.number().int().min(0),
  retries: z.number().int().min(0),
  queueDelayMs: z.number().int().min(0),
  processingMs: z.number().int().min(0),
  totalMs: z.number().int().min(0),
  costDollars: z.number().min(0),
  costEstimated: z.boolean(),
  costUnverified: z.boolean(),
});
export type CampaignSlotReportRow = z.infer<typeof CampaignSlotReportRowSchema>;

export const CampaignReportSchema = z.object({
  campaignId: z.string().min(1),
  protocol: CampaignProtocolSchema,
  manifestDigest: z.string().length(64),
  generatedAt: z.string().min(1),
  planned: z.number().int().min(0),
  statusCounts: z.record(CampaignTerminalStatusSchema, z.number().int().min(0)),
  /** Every planned slot holds a terminal outcome and none is missing/interrupted. */
  complete: z.boolean(),
  missing: z.array(z.object({ slotId: z.string().min(1), reason: z.string() })),
  completion: z.object({
    successes: z.number().int().min(0),
    rate: z.number().min(0),
  }),
  timing: z.object({
    successfulSamples: z.number().int().min(0),
    /** Nearest-rank p95 of successful processing durations; null with no sample. */
    p95ProcessingMs: z.number().min(0).nullable(),
    p95QueueDelayMs: z.number().min(0).nullable(),
  }),
  cost: z.object({
    totalDollars: z.number().min(0),
    estimatedDollars: z.number().min(0),
    unverifiedDollars: z.number().min(0),
    successfulCompletions: z.number().int().min(0),
    /** Undefined (null) at zero successes; never a fabricated zero. */
    perSuccessDollars: z.number().min(0).nullable(),
  }),
  semantic: z.array(CampaignSemanticCountSchema),
  slots: z.array(CampaignSlotReportRowSchema),
  goldenScores: z.array(CampaignGoldenScoreSchema),
  humanJudgments: z.array(CampaignHumanJudgmentSchema),
});
export type CampaignReport = z.infer<typeof CampaignReportSchema>;
