import {
  ValidationSlotOutcomeSchema,
  type CampaignSlot,
  type CampaignTerminalStatus,
  type ModelTimelineEntry,
  type OperationBudgetSnapshot,
  type ValidationSlotOutcome,
} from "@chief-of-staff-demo/shared";
import { modelDiagnosticEventDetail } from "../llm/failure.js";

/**
 * Terminal outcomes for planned slots (#363, MWR-020/022/057).
 *
 * Exactly one outcome is recorded per planned slot. A slot that already has an
 * outcome is never replaced — a later success does not overwrite an earlier
 * failure — and slots the run never produced are closed as `missing` with a
 * reason instead of disappearing from the denominator.
 */

export class SlotOutcomeConflictError extends Error {
  constructor(readonly slotId: string) {
    super(`Slot ${slotId} already has a terminal outcome; a recorded outcome is never replaced.`);
    this.name = "SlotOutcomeConflictError";
  }
}

const REASON_LIMIT = 500;

function boundedReason(error: unknown): string {
  const message =
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : typeof error === "string"
        ? error
        : "unknown failure";
  return message.replaceAll(/\s+/g, " ").slice(0, REASON_LIMIT);
}

/**
 * The terminal status an extraction failure earns. A reply that arrived but
 * did not match the expected Result Shape is `schema-invalid`; a cancellation
 * is `interrupted`; everything else is `failed`. The distinction is read from
 * the seam's own sanitized diagnostic, never from a message pattern.
 */
export function statusForExtractionError(error: unknown): {
  status: Exclude<CampaignTerminalStatus, "success" | "missing">;
  reason: string;
} {
  const detail = modelDiagnosticEventDetail(error);
  const reason = boundedReason(error);
  if (detail.resultShape !== undefined) return { status: "schema-invalid", reason };
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
    return { status: "interrupted", reason };
  }
  return { status: "failed", reason };
}

export interface DeriveSlotOutcomeInput {
  slot: CampaignSlot;
  status: CampaignTerminalStatus;
  reason?: string | null;
  artifactPath?: string | null;
  attempts?: number | undefined;
  processingMs: number;
  totalMs: number;
  /** Attempts the operation recorded in the timeline store (#357). */
  timeline: readonly ModelTimelineEntry[];
  /** The operation's durable budget snapshot (#357), or null outside the ledger. */
  ledger: OperationBudgetSnapshot | null;
  recordedAt: string;
}

/**
 * Builds one outcome from the seam facts rather than from a second set of
 * counters: charged attempts and spend come from the budget ledger, queue wait
 * and cost flags from the timeline entries, and the caller supplies the two
 * wall-clock measurements it actually observed.
 */
export function deriveSlotOutcome(input: DeriveSlotOutcomeInput): ValidationSlotOutcome {
  const timeline = input.timeline;
  const timelineCost = timeline.reduce((sum, entry) => sum + entry.cost.dollars, 0);
  const chargedAttempts = Math.max(input.ledger?.dispatches ?? 0, timeline.length);
  const ledgerSpend = input.ledger?.spentDollars;
  /* Spend no attempt ever reported usage for is a settled reservation: real
     budget consumed, but an estimate the provider never confirmed. */
  const ledgerOnlyCharge = ledgerSpend !== undefined && ledgerSpend > 0 && timeline.length === 0;
  return ValidationSlotOutcomeSchema.parse({
    slotId: input.slot.slotId,
    status: input.status,
    reason: input.reason ?? null,
    attempts: input.attempts ?? timeline.length,
    chargedAttempts,
    retries: timeline.filter((entry) => entry.outcome === "failed").length,
    queueDelayMs: timeline.reduce((sum, entry) => sum + entry.queueWaitMs, 0),
    processingMs: Math.max(0, Math.round(input.processingMs)),
    totalMs: Math.max(0, Math.round(input.totalMs)),
    costDollars: ledgerSpend ?? timelineCost,
    costEstimated: ledgerOnlyCharge || timeline.some((entry) => entry.cost.estimated),
    costUnverified: ledgerOnlyCharge || timeline.some((entry) => entry.cost.unverified),
    artifactPath: input.artifactPath ?? null,
    recordedAt: input.recordedAt,
  });
}

export function recordSlotOutcome(
  existing: readonly ValidationSlotOutcome[],
  outcome: ValidationSlotOutcome,
): ValidationSlotOutcome[] {
  if (existing.some((record) => record.slotId === outcome.slotId)) {
    throw new SlotOutcomeConflictError(outcome.slotId);
  }
  return [...existing, outcome];
}

/**
 * Closes a campaign: every planned slot without an outcome gets a `missing`
 * record carrying the reason the run did not produce one. Returns the added
 * records so a caller can append exactly those.
 */
export function finalizeCampaignOutcomes(input: {
  slots: readonly CampaignSlot[];
  outcomes: readonly ValidationSlotOutcome[];
  reason: string;
  recordedAt: string;
}): ValidationSlotOutcome[] {
  const recorded = new Set(input.outcomes.map((outcome) => outcome.slotId));
  return input.slots
    .filter((slot) => !recorded.has(slot.slotId))
    .map((slot) =>
      ValidationSlotOutcomeSchema.parse({
        slotId: slot.slotId,
        status: "missing",
        reason: input.reason,
        attempts: 0,
        chargedAttempts: 0,
        retries: 0,
        queueDelayMs: 0,
        processingMs: 0,
        totalMs: 0,
        costDollars: 0,
        costEstimated: false,
        costUnverified: false,
        artifactPath: null,
        recordedAt: input.recordedAt,
      }),
    );
}

export function encodeOutcomes(outcomes: readonly ValidationSlotOutcome[]): string {
  return outcomes
    .map((outcome) => JSON.stringify(outcome))
    .join("\n")
    .concat("\n");
}

export function decodeOutcomes(text: string): ValidationSlotOutcome[] {
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => ValidationSlotOutcomeSchema.parse(JSON.parse(line) as unknown));
}
