import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod/v3";
import {
  BRIEF_OPERATION_BUDGET_DOLLARS_DEFAULT,
  CAMPAIGN_BUDGET_DOLLARS_DEFAULT,
  CampaignBudgetSnapshotSchema,
  DEBRIEF_OPERATION_BUDGET_DOLLARS_DEFAULT,
  type ModelPriceEvidence,
  OPERATION_INPUT_TOKEN_CEILING_DEFAULT,
  OPERATION_OUTPUT_TOKEN_CEILING_DEFAULT,
  OperationBudgetSnapshotSchema,
  type SourceLifecycleGrant,
  type TokenReservationEstimate,
  defaultModelPriceEvidence,
  estimateConservativeTokens,
} from "@chief-of-staff-demo/shared";
import type { ModelUsageObservation } from "./providers.js";
import {
  ExpectedVersionConflictError,
  WorkspaceIntegrityError,
  writeJsonVerifiedSync,
} from "../engine/commit.js";
import { verifySourceGrant } from "./grants.js";

export class BudgetExhaustedError extends Error {
  constructor(
    readonly resource: "operation_dollars" | "campaign_dollars" | "input_tokens" | "output_tokens",
    readonly requested: number,
    readonly available: number,
    message = `Model budget exhausted for ${resource}: requested ${requested} exceeds available ${available}`,
  ) {
    super(message);
    this.name = "BudgetExhaustedError";
  }
}

export class ModelContextCapacityExceededError extends Error {
  constructor(
    readonly model: string,
    readonly estimatedTokens: number,
    readonly contextCapacityTokens: number,
    message = `Model context capacity exceeded for ${model}: estimated ${estimatedTokens} tokens exceeds context window of ${contextCapacityTokens} tokens`,
  ) {
    super(message);
    this.name = "ModelContextCapacityExceededError";
  }
}

export class UnknownModelPriceEvidenceError extends Error {
  constructor(
    readonly model: string,
    message = `Unknown price evidence and context window limits for model ${model}. Pricing evidence or explicit grant is required before dispatch.`,
  ) {
    super(message);
    this.name = "UnknownModelPriceEvidenceError";
  }
}

export class StaleOperationGenerationError extends Error {
  constructor(
    readonly operationId: string,
    readonly expectedGeneration: number,
    readonly currentGeneration: number,
    message = `Late write rejected: operation ${operationId} is at generation ${currentGeneration}, but write bound generation ${expectedGeneration}`,
  ) {
    super(message);
    this.name = "StaleOperationGenerationError";
  }
}

interface ActiveReservation {
  readonly reservationId: string;
  readonly operationId: string;
  readonly model: string;
  readonly estimate: TokenReservationEstimate;
  readonly priceEvidence: ModelPriceEvidence | undefined;
  readonly createdAt: string;
}

const ActiveReservationSchema = z.object({
  reservationId: z.string().min(1),
  operationId: z.string().min(1),
  model: z.string().min(1),
  estimate: z.object({
    estimatedInputTokens: z.number().int().min(0),
    estimatedOutputTokens: z.number().int().min(0),
    estimatedTotalTokens: z.number().int().min(0),
    estimatedCostDollars: z.number().min(0),
    contextWindowTokens: z.number().int().positive().optional(),
  }),
  priceEvidence: z
    .object({
      model: z.string().min(1),
      inputDollarsPerMillion: z.number().min(0),
      outputDollarsPerMillion: z.number().min(0),
      contextWindowTokens: z.number().int().positive(),
    })
    .optional(),
  createdAt: z.string().min(1),
});

const ModelBudgetLedgerDocumentSchema = z.object({
  version: z.number().int().min(1),
  campaign: CampaignBudgetSnapshotSchema,
  operations: z.record(z.string(), OperationBudgetSnapshotSchema),
  reservations: z.record(z.string(), ActiveReservationSchema),
});
type ModelBudgetLedgerDocument = z.infer<typeof ModelBudgetLedgerDocumentSchema>;

export interface ReserveOptions {
  operationId: string;
  model: string;
  system: string;
  user: string;
  schema?: unknown;
  outputReserveTokens?: number | undefined;
  grant?: SourceLifecycleGrant | null | undefined;
}

export interface ReservationResult {
  reservationId: string;
  estimate: TokenReservationEstimate;
  priceEvidence: ModelPriceEvidence | undefined;
}

export interface ExtendOperationOptions {
  addedDollars: number;
  expectedVersion: number;
  addedInputTokens?: number | undefined;
  addedOutputTokens?: number | undefined;
  reason?: string | undefined;
}

/**
 * Durable ledger tracking campaign ($100) and operation ($2) budgets across crashes,
 * restarts, and variants (#346, #357, MWR-025, MWR-026).
 */
export class ModelBudgetLedger {
  private readonly filePath: string;
  private readonly priceEvidenceTable: Map<string, ModelPriceEvidence>;
  private readonly now: () => Date;
  private document: ModelBudgetLedgerDocument;
  private readonly activeAttempts = new Map<string, Set<Promise<unknown>>>();

  constructor(
    workspaceDir: string,
    options: {
      now?: (() => Date) | undefined;
      priceEvidenceTable?: Map<string, ModelPriceEvidence> | undefined;
    } = {},
  ) {
    this.filePath = join(workspaceDir, "model-budget-ledger.json");
    this.priceEvidenceTable = options.priceEvidenceTable ?? defaultModelPriceEvidence();
    this.now = options.now ?? (() => new Date());
    this.document = this.loadOrCreate();
  }

  private loadOrCreate(): ModelBudgetLedgerDocument {
    if (!existsSync(this.filePath)) {
      const initial: ModelBudgetLedgerDocument = {
        version: 1,
        campaign: {
          allowedDollars: CAMPAIGN_BUDGET_DOLLARS_DEFAULT,
          spentDollars: 0.0,
          reservedDollars: 0.0,
          remainingDollars: CAMPAIGN_BUDGET_DOLLARS_DEFAULT,
          version: 1,
          updatedAt: this.now().toISOString(),
        },
        operations: {},
        reservations: {},
      };
      // Lazy persistence: hold initial state in memory until first write
      return initial;
    }

    try {
      const raw = readFileSync(this.filePath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      return ModelBudgetLedgerDocumentSchema.parse(parsed);
    } catch (error) {
      throw new WorkspaceIntegrityError(
        `Corrupt model budget ledger at ${this.filePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private persist(doc: ModelBudgetLedgerDocument): void {
    writeJsonVerifiedSync(this.filePath, doc);
    this.document = doc;
  }

  getCampaignSnapshot() {
    return { ...this.document.campaign };
  }

  getOperationSnapshot(operationId: string) {
    const op = this.document.operations[operationId];
    return op ? { ...op } : null;
  }

  getOrCreateOperationSnapshot(
    operationId: string,
    runId?: string | null,
    kind: "debrief" | "brief" | "other" = "debrief",
    options?: { allowedDollars?: number | undefined },
  ) {
    const existing = this.document.operations[operationId];
    if (existing) return { ...existing };

    const defaultAllowance =
      kind === "brief"
        ? BRIEF_OPERATION_BUDGET_DOLLARS_DEFAULT
        : DEBRIEF_OPERATION_BUDGET_DOLLARS_DEFAULT;

    const allowedDollars = options?.allowedDollars ?? defaultAllowance;

    const newOp: z.infer<typeof OperationBudgetSnapshotSchema> = {
      operationId,
      runId: runId ?? null,
      version: 1,
      generation: 1,
      allowedDollars,
      spentDollars: 0.0,
      reservedDollars: 0.0,
      remainingDollars: allowedDollars,
      allowedInputTokens: OPERATION_INPUT_TOKEN_CEILING_DEFAULT,
      spentInputTokens: 0,
      reservedInputTokens: 0,
      allowedOutputTokens: OPERATION_OUTPUT_TOKEN_CEILING_DEFAULT,
      spentOutputTokens: 0,
      reservedOutputTokens: 0,
      startedAt: this.now().toISOString(),
      elapsedProcessingMs: 0,
      status: "active",
      extensions: [],
      dispatches: 0,
    };

    const nextDoc: ModelBudgetLedgerDocument = {
      ...this.document,
      version: this.document.version + 1,
      operations: {
        ...this.document.operations,
        [operationId]: newOp,
      },
    };
    this.persist(nextDoc);
    return { ...newOp };
  }

  reserve(options: ReserveOptions): ReservationResult {
    const { operationId, model, system, user, schema, outputReserveTokens, grant } = options;

    // 1. Grant verification (#341, #356, MWR-051)
    const grantCheck = verifySourceGrant(grant, model);
    if (!grantCheck.ok) {
      throw new Error(`Dispatch blocked by source grant policy: ${grantCheck.reason}`);
    }

    // 2. Price and context evidence check (#346, MWR-025, MWR-026)
    const priceEvidence = this.resolvePriceEvidence(model);
    if (!priceEvidence && model !== "mock" && !model.endsWith(":free")) {
      throw new UnknownModelPriceEvidenceError(model);
    }

    // 3. Conservative token estimation (UTF-8 byte bound + reserves)
    const estimate = estimateConservativeTokens({
      system,
      user,
      schema,
      outputReserveTokens,
      priceEvidence: priceEvidence ?? undefined,
    });

    // 4. Context capacity check
    const contextCapacity = priceEvidence?.contextWindowTokens ?? 1_000_000;
    if (estimate.estimatedTotalTokens > contextCapacity) {
      throw new ModelContextCapacityExceededError(
        model,
        estimate.estimatedTotalTokens,
        contextCapacity,
      );
    }

    // 5. Operation and Campaign budget checks
    const op = this.getOrCreateOperationSnapshot(operationId);
    if (op.status === "cancelled") {
      throw new Error(`Operation ${operationId} is cancelled`);
    }

    if (op.remainingDollars < estimate.estimatedCostDollars) {
      throw new BudgetExhaustedError(
        "operation_dollars",
        estimate.estimatedCostDollars,
        op.remainingDollars,
      );
    }

    const campaign = this.document.campaign;
    if (campaign.remainingDollars < estimate.estimatedCostDollars) {
      throw new BudgetExhaustedError(
        "campaign_dollars",
        estimate.estimatedCostDollars,
        campaign.remainingDollars,
      );
    }

    const remainingOpInputTokens =
      op.allowedInputTokens - (op.spentInputTokens + op.reservedInputTokens);
    if (remainingOpInputTokens < estimate.estimatedInputTokens) {
      throw new BudgetExhaustedError(
        "input_tokens",
        estimate.estimatedInputTokens,
        remainingOpInputTokens,
      );
    }

    const remainingOpOutputTokens =
      op.allowedOutputTokens - (op.spentOutputTokens + op.reservedOutputTokens);
    if (remainingOpOutputTokens < estimate.estimatedOutputTokens) {
      throw new BudgetExhaustedError(
        "output_tokens",
        estimate.estimatedOutputTokens,
        remainingOpOutputTokens,
      );
    }

    // 6. Record reservation
    const reservationId = randomUUID();
    const activeReservation: ActiveReservation = {
      reservationId,
      operationId,
      model,
      estimate,
      priceEvidence: priceEvidence ?? undefined,
      createdAt: this.now().toISOString(),
    };

    const updatedOp = {
      ...op,
      reservedDollars: op.reservedDollars + estimate.estimatedCostDollars,
      remainingDollars: Math.max(
        0,
        op.allowedDollars - (op.spentDollars + op.reservedDollars + estimate.estimatedCostDollars),
      ),
      reservedInputTokens: op.reservedInputTokens + estimate.estimatedInputTokens,
      reservedOutputTokens: op.reservedOutputTokens + estimate.estimatedOutputTokens,
      version: op.version + 1,
    };

    const updatedCampaign = {
      ...campaign,
      reservedDollars: campaign.reservedDollars + estimate.estimatedCostDollars,
      remainingDollars: Math.max(
        0,
        campaign.allowedDollars -
          (campaign.spentDollars + campaign.reservedDollars + estimate.estimatedCostDollars),
      ),
      version: campaign.version + 1,
      updatedAt: this.now().toISOString(),
    };

    const nextDoc: ModelBudgetLedgerDocument = {
      version: this.document.version + 1,
      campaign: updatedCampaign,
      operations: {
        ...this.document.operations,
        [operationId]: updatedOp,
      },
      reservations: {
        ...this.document.reservations,
        [reservationId]: activeReservation,
      },
    };

    this.persist(nextDoc);

    return {
      reservationId,
      estimate,
      priceEvidence: priceEvidence ?? undefined,
    };
  }

  settle(reservationId: string, usage: ModelUsageObservation | null | undefined): void {
    const reservation = this.document.reservations[reservationId];
    if (!reservation) return;

    const op = this.document.operations[reservation.operationId];
    if (!op) return;

    const campaign = this.document.campaign;
    const reservedCost = reservation.estimate.estimatedCostDollars;
    const reservedInput = reservation.estimate.estimatedInputTokens;
    const reservedOutput = reservation.estimate.estimatedOutputTokens;

    let actualCost = reservedCost;
    let actualInput = reservedInput;
    let actualOutput = reservedOutput;

    if (usage) {
      if (usage.costUsd !== null) {
        actualCost = usage.costUsd;
      } else if (reservation.priceEvidence) {
        const inputTokens = usage.inputTokens ?? reservedInput;
        const outputTokens = usage.outputTokens ?? reservedOutput;
        const inputCost =
          (inputTokens / 1_000_000) * reservation.priceEvidence.inputDollarsPerMillion;
        const outputCost =
          (outputTokens / 1_000_000) * reservation.priceEvidence.outputDollarsPerMillion;
        actualCost = inputCost + outputCost;
      }

      if (usage.inputTokens !== null) actualInput = usage.inputTokens;
      if (usage.outputTokens !== null) actualOutput = usage.outputTokens;
    }

    const updatedOpSpentDollars = op.spentDollars + actualCost;
    const updatedOpReservedDollars = Math.max(0, op.reservedDollars - reservedCost);
    const updatedOpRemainingDollars = Math.max(
      0,
      op.allowedDollars - (updatedOpSpentDollars + updatedOpReservedDollars),
    );

    const updatedOp = {
      ...op,
      spentDollars: updatedOpSpentDollars,
      reservedDollars: updatedOpReservedDollars,
      remainingDollars: updatedOpRemainingDollars,
      spentInputTokens: op.spentInputTokens + actualInput,
      reservedInputTokens: Math.max(0, op.reservedInputTokens - reservedInput),
      spentOutputTokens: op.spentOutputTokens + actualOutput,
      reservedOutputTokens: Math.max(0, op.reservedOutputTokens - reservedOutput),
      dispatches: op.dispatches + 1,
      version: op.version + 1,
    };

    const updatedCampaignSpentDollars = campaign.spentDollars + actualCost;
    const updatedCampaignReservedDollars = Math.max(0, campaign.reservedDollars - reservedCost);
    const updatedCampaignRemainingDollars = Math.max(
      0,
      campaign.allowedDollars - (updatedCampaignSpentDollars + updatedCampaignReservedDollars),
    );

    const updatedCampaign = {
      ...campaign,
      spentDollars: updatedCampaignSpentDollars,
      reservedDollars: updatedCampaignReservedDollars,
      remainingDollars: updatedCampaignRemainingDollars,
      version: campaign.version + 1,
      updatedAt: this.now().toISOString(),
    };

    const nextReservations = { ...this.document.reservations };
    delete nextReservations[reservationId];

    const nextDoc: ModelBudgetLedgerDocument = {
      version: this.document.version + 1,
      campaign: updatedCampaign,
      operations: {
        ...this.document.operations,
        [op.operationId]: updatedOp,
      },
      reservations: nextReservations,
    };

    this.persist(nextDoc);
  }

  extendOperation(operationId: string, options: ExtendOperationOptions) {
    const op = this.document.operations[operationId];
    if (!op) {
      throw new Error(`Operation ${operationId} not found in model budget ledger`);
    }

    if (op.version !== options.expectedVersion) {
      throw new ExpectedVersionConflictError(this.filePath, options.expectedVersion, op.version);
    }

    const addedDollars = options.addedDollars;
    const addedInputTokens = options.addedInputTokens ?? 0;
    const addedOutputTokens = options.addedOutputTokens ?? 0;

    const extension = {
      addedDollars,
      ...(addedInputTokens > 0 ? { addedInputTokens } : {}),
      ...(addedOutputTokens > 0 ? { addedOutputTokens } : {}),
      grantedAt: this.now().toISOString(),
      ...(options.reason ? { reason: options.reason } : {}),
    };

    const updatedAllowedDollars = op.allowedDollars + addedDollars;
    const updatedRemainingDollars = op.remainingDollars + addedDollars;

    const updatedOp: z.infer<typeof OperationBudgetSnapshotSchema> = {
      ...op,
      allowedDollars: updatedAllowedDollars,
      remainingDollars: updatedRemainingDollars,
      allowedInputTokens: op.allowedInputTokens + addedInputTokens,
      allowedOutputTokens: op.allowedOutputTokens + addedOutputTokens,
      extensions: [...op.extensions, extension],
      version: op.version + 1,
    };

    const nextDoc: ModelBudgetLedgerDocument = {
      version: this.document.version + 1,
      campaign: this.document.campaign,
      operations: {
        ...this.document.operations,
        [operationId]: updatedOp,
      },
      reservations: this.document.reservations,
    };

    this.persist(nextDoc);
    return { ...updatedOp };
  }

  cancelOperation(operationId: string): void {
    const op = this.document.operations[operationId];
    if (!op) return;

    const updatedOp = {
      ...op,
      generation: op.generation + 1,
      status: "cancelled" as const,
      version: op.version + 1,
    };

    const nextDoc: ModelBudgetLedgerDocument = {
      version: this.document.version + 1,
      campaign: this.document.campaign,
      operations: {
        ...this.document.operations,
        [operationId]: updatedOp,
      },
      reservations: this.document.reservations,
    };

    this.persist(nextDoc);
  }

  private resolvePriceEvidence(model: string): ModelPriceEvidence | null {
    if (this.priceEvidenceTable.has(model)) {
      return this.priceEvidenceTable.get(model)!;
    }
    // Also check prefix/suffix match (e.g. openrouter/solar-pro4 vs upstage/solar-pro4)
    for (const [key, val] of this.priceEvidenceTable) {
      if (model.includes(key) || key.includes(model)) return val;
    }
    return null;
  }

  assertGeneration(operationId: string, expectedGeneration: number): void {
    const op = this.document.operations[operationId];
    if (!op) return;
    if (op.generation !== expectedGeneration) {
      throw new StaleOperationGenerationError(operationId, expectedGeneration, op.generation);
    }
  }

  trackActiveAttempt(operationId: string, attempt: Promise<unknown>): void {
    let set = this.activeAttempts.get(operationId);
    if (!set) {
      set = new Set();
      this.activeAttempts.set(operationId, set);
    }
    set.add(attempt);
    const clean = () => {
      set.delete(attempt);
      if (set.size === 0) {
        this.activeAttempts.delete(operationId);
      }
    };
    attempt.then(clean, clean);
  }

  hasActiveAttempts(operationId: string): boolean {
    const set = this.activeAttempts.get(operationId);
    return Boolean(set && set.size > 0);
  }

  async settleActiveAttempts(operationId: string): Promise<void> {
    const set = this.activeAttempts.get(operationId);
    if (!set || set.size === 0) return;
    await Promise.allSettled(Array.from(set));
  }
}
