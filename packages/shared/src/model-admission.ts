import { z } from "zod/v3";

/**
 * Priority tiers for shared model admission (#346, MWR-024).
 */
export const MODEL_ADMISSION_PRIORITIES = ["time-sensitive", "normal"] as const;
export type ModelAdmissionPriority = (typeof MODEL_ADMISSION_PRIORITIES)[number];
export const ModelAdmissionPrioritySchema = z.enum(MODEL_ADMISSION_PRIORITIES);

export const ADMISSION_OUTCOMES = [
  "admitted",
  "completed",
  "failed",
  "expired",
  "cancelled",
  "rejected",
] as const;
export type AdmissionOutcome = (typeof ADMISSION_OUTCOMES)[number];
export const AdmissionOutcomeSchema = z.enum(ADMISSION_OUTCOMES);

/**
 * Shared model admission configuration defaults (#346, MWR-023, MWR-024).
 */
export const ModelAdmissionConfigSchema = z.object({
  /** Maximum active concurrent provider attempts across the whole process. */
  maxActiveAttempts: z.number().int().min(1).max(32).default(4),
  /** Maximum consecutive time-sensitive admissions while normal work waits before admitting normal request. */
  starvationThresholdConsecutive: z.number().int().min(1).max(10).default(3),
  /** Maximum queue wait before an aged normal request takes the next slot immediately (ms). */
  agedNormalThresholdMs: z.number().int().min(1_000).max(600_000).default(60_000),
  /** Maximum whole-operation time spent waiting in admission queue before expiry (ms). */
  queueAgeLimitMs: z
    .number()
    .int()
    .min(10_000)
    .max(7_200_000)
    .default(30 * 60_000),
  /** Maximum processing deadline for whole operation (ms). */
  processingDeadlineMs: z
    .number()
    .int()
    .min(10_000)
    .max(7_200_000)
    .default(15 * 60_000),
});
export type ModelAdmissionConfig = z.infer<typeof ModelAdmissionConfigSchema>;

/**
 * Cumulative operation and campaign budget defaults (#346, MWR-025).
 */
export const CAMPAIGN_BUDGET_DOLLARS_DEFAULT = 100.0;
export const DEBRIEF_OPERATION_BUDGET_DOLLARS_DEFAULT = 2.0;
export const BRIEF_OPERATION_BUDGET_DOLLARS_DEFAULT = 2.0;
export const OPERATION_INPUT_TOKEN_CEILING_DEFAULT = 4_000_000;
export const OPERATION_OUTPUT_TOKEN_CEILING_DEFAULT = 500_000;

export const ModelPriceEvidenceSchema = z.object({
  model: z.string().min(1),
  inputDollarsPerMillion: z.number().min(0),
  outputDollarsPerMillion: z.number().min(0),
  contextWindowTokens: z.number().int().positive(),
});
export type ModelPriceEvidence = z.infer<typeof ModelPriceEvidenceSchema>;

/**
 * Standard known endpoint pricing and context limits for development and test models.
 */
export function defaultModelPriceEvidence(): Map<string, ModelPriceEvidence> {
  const table = new Map<string, ModelPriceEvidence>();

  const add = (evidence: ModelPriceEvidence) => {
    table.set(evidence.model, evidence);
  };

  // Development models (#341, #346, #351)
  add({
    model: "deepseek/deepseek-v4.1-flash",
    inputDollarsPerMillion: 0.14,
    outputDollarsPerMillion: 0.28,
    contextWindowTokens: 64_000,
  });
  add({
    model: "nvidia/nemotron-3.5-lightning",
    inputDollarsPerMillion: 0.2,
    outputDollarsPerMillion: 0.4,
    contextWindowTokens: 128_000,
  });
  add({
    model: "nex-agi/nex-n2.5-mini:free",
    inputDollarsPerMillion: 0.0,
    outputDollarsPerMillion: 0.0,
    contextWindowTokens: 128_000,
  });
  /* The owner's free-only baseline campaign set (#363, 2026-09-12): every
     endpoint advertises zero input and output price on OpenRouter. */
  add({
    model: "thinkingmachines/inkling-small:free",
    inputDollarsPerMillion: 0.0,
    outputDollarsPerMillion: 0.0,
    contextWindowTokens: 1_048_576,
  });
  add({
    model: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
    inputDollarsPerMillion: 0.0,
    outputDollarsPerMillion: 0.0,
    contextWindowTokens: 256_000,
  });
  add({
    model: "poolside/laguna-xs-2.1:free",
    inputDollarsPerMillion: 0.0,
    outputDollarsPerMillion: 0.0,
    contextWindowTokens: 262_144,
  });
  add({
    model: "nvidia/nemotron-3-super-120b-a12b:free",
    inputDollarsPerMillion: 0.0,
    outputDollarsPerMillion: 0.0,
    contextWindowTokens: 262_144,
  });

  // Solar eval gate model
  add({
    model: "upstage/solar-pro4",
    inputDollarsPerMillion: 0.25,
    outputDollarsPerMillion: 0.25,
    contextWindowTokens: 32_768,
  });

  // Providers & common models
  add({
    model: "gpt-5.2",
    inputDollarsPerMillion: 2.5,
    outputDollarsPerMillion: 10.0,
    contextWindowTokens: 128_000,
  });
  add({
    model: "claude-sonnet-5",
    inputDollarsPerMillion: 3.0,
    outputDollarsPerMillion: 15.0,
    contextWindowTokens: 200_000,
  });
  add({
    model: "gemini-3.7-flash",
    inputDollarsPerMillion: 0.1,
    outputDollarsPerMillion: 0.4,
    contextWindowTokens: 1_000_000,
  });
  add({
    model: "inception/mercury-2.5",
    inputDollarsPerMillion: 0.04,
    outputDollarsPerMillion: 0.15,
    contextWindowTokens: 260_000,
  });
  add({
    model: "z-ai/glm-5.3-flash",
    inputDollarsPerMillion: 0.2,
    outputDollarsPerMillion: 0.4,
    contextWindowTokens: 128_000,
  });
  add({
    model: "nemotron",
    inputDollarsPerMillion: 0.0,
    outputDollarsPerMillion: 0.0,
    contextWindowTokens: 32_768,
  });
  add({
    model: "mock",
    inputDollarsPerMillion: 0.0,
    outputDollarsPerMillion: 0.0,
    contextWindowTokens: 1_000_000,
  });

  return table;
}

export const TokenReservationEstimateSchema = z.object({
  estimatedInputTokens: z.number().int().min(0),
  estimatedOutputTokens: z.number().int().min(0),
  estimatedTotalTokens: z.number().int().min(0),
  estimatedCostDollars: z.number().min(0),
  contextWindowTokens: z.number().int().positive().optional(),
});
export type TokenReservationEstimate = z.infer<typeof TokenReservationEstimateSchema>;

/**
 * Exact UTF-8 byte length for any string, self-contained without Node Buffer or DOM TextEncoder globals.
 */
export function utf8ByteLength(str: string): number {
  let bytes = 0;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      // Surrogate pair (4 bytes in UTF-8)
      bytes += 4;
      i++;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/**
 * Estimates conservative token requirements using UTF-8 byte bounds rather than character counts (#346, MWR-026).
 * Multi-byte UTF-8 bytes and schema formatting are bounded conservatively with framing reserves.
 */
export function estimateConservativeTokens(options: {
  system: string;
  user: string;
  schema?: unknown;
  outputReserveTokens?: number | undefined;
  priceEvidence?: ModelPriceEvidence | undefined;
}): TokenReservationEstimate {
  const { system, user, schema, outputReserveTokens = 4096, priceEvidence } = options;
  const systemBytes = utf8ByteLength(system);
  const userBytes = utf8ByteLength(user);
  const schemaBytes = schema !== undefined ? utf8ByteLength(JSON.stringify(schema)) : 0;
  const totalInputBytes = systemBytes + userBytes + schemaBytes;
  // Conservative UTF-8 byte bound: in dense tokenization, 1.5 - 2 bytes per token;
  // using ceil(bytes / 1.5) + framing reserve (256 tokens) ensures we never underestimate tokens.
  const estimatedInputTokens = Math.ceil(totalInputBytes / 1.5) + 256;
  const estimatedOutputTokens = Math.max(1, outputReserveTokens);
  const estimatedTotalTokens = estimatedInputTokens + estimatedOutputTokens;

  let estimatedCostDollars = 0;
  if (priceEvidence) {
    const inputCost = (estimatedInputTokens / 1_000_000) * priceEvidence.inputDollarsPerMillion;
    const outputCost = (estimatedOutputTokens / 1_000_000) * priceEvidence.outputDollarsPerMillion;
    estimatedCostDollars = inputCost + outputCost;
  }

  return {
    estimatedInputTokens,
    estimatedOutputTokens,
    estimatedTotalTokens,
    estimatedCostDollars,
    contextWindowTokens: priceEvidence?.contextWindowTokens,
  };
}

export const CampaignBudgetSnapshotSchema = z.object({
  allowedDollars: z.number().min(0),
  spentDollars: z.number().min(0),
  reservedDollars: z.number().min(0),
  remainingDollars: z.number().min(0),
  version: z.number().int().min(1),
  updatedAt: z.string().min(1),
});
export type CampaignBudgetSnapshot = z.infer<typeof CampaignBudgetSnapshotSchema>;

export const OperationBudgetSnapshotSchema = z.object({
  operationId: z.string().min(1),
  runId: z.string().nullable().optional(),
  version: z.number().int().min(1),
  generation: z.number().int().min(1),
  allowedDollars: z.number().min(0),
  spentDollars: z.number().min(0),
  reservedDollars: z.number().min(0),
  remainingDollars: z.number().min(0),
  allowedInputTokens: z.number().int().min(0),
  spentInputTokens: z.number().int().min(0),
  reservedInputTokens: z.number().int().min(0),
  allowedOutputTokens: z.number().int().min(0),
  spentOutputTokens: z.number().int().min(0),
  reservedOutputTokens: z.number().int().min(0),
  startedAt: z.string().nullable(),
  elapsedProcessingMs: z.number().int().min(0),
  status: z.enum(["active", "exhausted", "cancelled", "completed"]),
  extensions: z.array(
    z.object({
      addedDollars: z.number().positive(),
      addedInputTokens: z.number().int().min(0).optional(),
      addedOutputTokens: z.number().int().min(0).optional(),
      grantedAt: z.string().min(1),
      reason: z.string().optional(),
    }),
  ),
  dispatches: z.number().int().min(0),
});
export type OperationBudgetSnapshot = z.infer<typeof OperationBudgetSnapshotSchema>;

export const ModelTimelineEntrySchema = z.object({
  attemptId: z.string().min(1),
  operationId: z.string().min(1),
  runId: z.string().nullable(),
  stage: z.string().min(1),
  enqueuedAt: z.string().min(1),
  admittedAt: z.string().min(1),
  settledAt: z.string().min(1),
  queueWaitMs: z.number().int().min(0),
  durationMs: z.number().int().min(0),
  provider: z.string().min(1),
  model: z.string().min(1),
  binding: z.string().min(1),
  priority: ModelAdmissionPrioritySchema,
  outcome: z.enum(["completed", "failed", "cancelled", "expired"]),
  tokens: z.object({
    promptTokens: z.number().int().min(0),
    completionTokens: z.number().int().min(0),
    totalTokens: z.number().int().min(0),
    estimated: z.boolean(),
  }),
  cost: z.object({
    dollars: z.number().min(0),
    estimated: z.boolean(),
    unverified: z.boolean(),
  }),
  failureClassification: z.string().nullable().optional(),
  validationOutcome: z.enum(["valid", "repaired", "invalid"]).nullable().optional(),
  /**
   * Measurement attribution (issue #381). The purpose the call was resolved
   * for and the call site that made it: the request shape alone cannot tell
   * a claim extraction from a dossier extraction, so the caller says.
   */
  purpose: z.string().max(80).optional(),
  callSite: z.string().max(120).optional(),
  /**
   * Opaque exact-request fingerprint: a hash over the resolved configuration
   * and every request dependency, never the request text. Two entries with
   * one fingerprint asked the configured model the same question.
   */
  requestFingerprint: z.string().length(64).optional(),
  /** Provider wire attempts this logical invocation made, retries included. */
  wireAttempts: z.number().int().min(0).optional(),
  /** Prompt tokens the provider reported as served from its input cache. */
  cachedPromptTokens: z.number().int().min(0).nullable().optional(),
});
export type ModelTimelineEntry = z.infer<typeof ModelTimelineEntrySchema>;

export const CorpusLoadReportSchema = z.object({
  measuredAt: z.string().min(1),
  transcriptTokenDistribution: z.object({
    count: z.number().int().min(0),
    minTokens: z.number().int().min(0),
    maxTokens: z.number().int().min(0),
    meanTokens: z.number().min(0),
    medianTokens: z.number().min(0),
  }),
  candidateDensity: z.object({
    totalCandidates: z.number().int().min(0),
    totalTranscriptTokens: z.number().int().min(0),
    candidatesPerThousandTokens: z.number().min(0),
  }),
  duplicateObservationRate: z.object({
    totalObservations: z.number().int().min(0),
    duplicateObservations: z.number().int().min(0),
    duplicateRate: z.number().min(0),
  }),
  repairsByValidator: z.record(z.string(), z.number().int().min(0)),
  arrivalsAndDurations: z.array(
    z.object({
      operationId: z.string().min(1),
      arrivedAt: z.string().min(1),
      totalDurationMs: z.number().int().min(0),
      stageDurationsMs: z.record(z.string(), z.number().int().min(0)),
    }),
  ),
});
export type CorpusLoadReport = z.infer<typeof CorpusLoadReportSchema>;
