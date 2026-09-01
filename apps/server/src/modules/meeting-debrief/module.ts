import type {
  MeetingDebriefExtraction,
  MeetingDebriefRunResult,
  MeetingDebriefReviewState,
  TranscriptRecord,
} from "@chief-of-staff-demo/shared";
import {
  MEETING_DEBRIEF_EXPIRED_REASON,
  MEETING_DEBRIEF_MODULE_ID,
  MEETING_DEBRIEF_MODULE_VERSION,
  MeetingDebriefExtractionSchema,
} from "@chief-of-staff-demo/shared";
import type { CompleteJson } from "../../llm/providers.js";
import { modelDiagnosticEventDetail, parseResultShape } from "../../llm/failure.js";
import { errorMessage } from "../../engine/failure.js";
import type { RunOutcome } from "../../runs.js";
import type { RunContext, ShellModule } from "../../engine/module.js";
import type {
  DebriefCatalogReader,
  DebriefExtractInput,
  DebriefIdentityReview,
  DebriefIdentityReviewReader,
} from "./deps.js";
import {
  MEETING_DEBRIEF_REVIEW_EXPIRY_MS,
  REVIEW_WAIT_REASON,
  approvalBlockers,
  initialReviewState,
  mergeRegeneratedField,
  parseReviewState,
  serializeReviewState,
  type DebriefApprovalGateDeps,
} from "./review.js";
import { buildDebriefMessages, resolveActionItemOwners } from "./extraction.js";

export type {
  DebriefCatalogReader,
  DebriefExtractInput,
  DebriefIdentityReviewReader,
} from "./deps.js";

const MAX_EXTRACT_ATTEMPTS = 3;

/**
 * The Module's input. `fresh` comes from the Catalog's mining hand-off,
 * `resume` from a Stage retry, and `review` from the durable review wait —
 * clock-driven when the window elapses (`expire`), owner-driven otherwise.
 */
export type DebriefInput =
  | { kind: "fresh"; transcriptId: string }
  | { kind: "resume"; fromStage: "associate" | "extract" }
  | { kind: "review"; action: "owner" | "expire" };

export interface MeetingDebriefModuleDeps {
  now?: () => Date;
  catalog: DebriefCatalogReader;
  identity: DebriefIdentityReviewReader;
  /** Deterministic extraction seam (tests, hermetic runtimes). */
  extract?: (input: DebriefExtractInput) => Promise<MeetingDebriefExtraction>;
  /** Model-backed extraction when no override is injected. */
  getCompleteJson?: () => CompleteJson;
  /** Provider/model recorded on extract_attempt events for diagnosis. */
  getLlmInfo?: () => { provider: string; model: string };
  /**
   * The approval gate's collaborators (spec #450). Absent — as in a minimal
   * extraction-only harness — the gate stays closed: without a confirmed
   * owner identity and a Profile directory, no Debrief can be approved.
   */
  gate?: DebriefApprovalGateDeps;
}

/** How the Run's association stands, read from the immutable record itself. */
function rosterStatusOf(record: TranscriptRecord): "prefilled" | "requires_confirmation" {
  return record.occurrence !== null && record.roster.length > 0
    ? "prefilled"
    : "requires_confirmation";
}

async function extractWithModel(
  ctx: RunContext,
  record: TranscriptRecord,
  identity: DebriefIdentityReview,
  deps: MeetingDebriefModuleDeps,
): Promise<MeetingDebriefExtraction> {
  if (!deps.getCompleteJson) {
    throw new Error("Meeting Debrief extraction provider is unavailable");
  }
  const messages = buildDebriefMessages(record, identity);
  let lastFailure: unknown = null;
  let parsed: MeetingDebriefExtraction | null = null;
  for (let round = 1; round <= MAX_EXTRACT_ATTEMPTS; round++) {
    const attempt = ctx.attempt();
    const llm = deps.getLlmInfo?.() ?? { provider: "unknown", model: "unknown" };
    ctx.event("extract_attempt", { attempt, provider: llm.provider, model: llm.model });
    try {
      const raw = await deps.getCompleteJson()({
        system: messages.system,
        user: messages.user,
        schema: messages.schema,
      });
      parsed = parseResultShape("MeetingDebriefExtraction", MeetingDebriefExtractionSchema, raw);
      ctx.event("extract_ok", { attempt });
      break;
    } catch (error) {
      ctx.event("extract_error", {
        attempt,
        error: errorMessage(error),
        ...modelDiagnosticEventDetail(error),
      });
      lastFailure = error;
    }
  }
  if (!parsed) {
    if (Object.keys(modelDiagnosticEventDetail(lastFailure)).length > 0) {
      throw lastFailure;
    }
    throw new Error(`extraction failed after ${MAX_EXTRACT_ATTEMPTS} attempts`);
  }
  return parsed;
}

/** The current stored debrief, for merging a regenerated field into. */
function currentDebrief(ctx: RunContext): MeetingDebriefExtraction {
  const raw = ctx.readFile("result.json");
  if (!raw) throw new Error("Debrief Run has no stored result to regenerate from");
  return (JSON.parse(raw) as MeetingDebriefRunResult).debrief;
}

/**
 * Meeting Debrief v2 — extract, then wait for the owner (issues #139/#140).
 * The review wait is a Shell-owned durable wait (ADR-0038): it resumes when
 * the owner approves or regenerates, and expires to `skipped` after thirty
 * days. Regeneration is a Stage of its own whose model call sees only the
 * immutable input — the rejected value is structurally unreachable
 * (ADR-0037). The Module receives no outward-write capability at all, so a
 * Debrief Run structurally cannot write one.
 */
export function meetingDebriefModule(deps: MeetingDebriefModuleDeps): ShellModule<DebriefInput> {
  const now = deps.now ?? (() => new Date());
  /* A harness without a gate stays closed: no confirmed owner identity and no
     Profile directory can only ever mean "blocked", never "approved". */
  const gate: DebriefApprovalGateDeps = deps.gate ?? {
    ownerEmail: () => null,
    verifiedForEmail: () => null,
  };

  const extract = async (
    ctx: RunContext,
    record: TranscriptRecord,
  ): Promise<MeetingDebriefExtraction> => {
    const identity = deps.identity.reviewFor(record.id);
    const debrief = deps.extract
      ? await deps.extract({ record, identity })
      : await extractWithModel(ctx, record, identity, deps);
    return resolveActionItemOwners(debrief, deps.identity.reviewFor(record.id));
  };

  /** Store the result of a finished extraction or regeneration on the Run. */
  const storeResult = (
    ctx: RunContext,
    debrief: MeetingDebriefExtraction,
    transcriptId: string,
  ): void => {
    const result: MeetingDebriefRunResult = {
      version: 1,
      transcriptId,
      extractedAt: now().toISOString(),
      debrief,
    };
    ctx.writeFile("result.json", JSON.stringify(result, null, 2) + "\n");
  };

  /**
   * The review wait (ADR-0020's durable wait, ADR-0038's shape): ensure the
   * review record, then stop the Run inside the open Stage. Never returns —
   * `ctx.wait` unrolls the Run into `blocked`.
   */
  const wait = (ctx: RunContext, deadline?: string): never => {
    ctx.wait({
      reason: REVIEW_WAIT_REASON,
      timeout: {
        kind: "at",
        at: deadline ?? new Date(now().getTime() + MEETING_DEBRIEF_REVIEW_EXPIRY_MS).toISOString(),
      },
    });
  };

  const ensureReviewState = (
    ctx: RunContext,
    record: TranscriptRecord,
  ): MeetingDebriefReviewState => {
    const existing = parseReviewState(ctx.readFile("review.json"));
    if (existing) return existing;
    const state = initialReviewState(ctx.runId, record);
    ctx.writeFile("review.json", serializeReviewState(state));
    return state;
  };

  /**
   * One review Turn: the Run has resumed out of its wait for a clock or an
   * owner reason. Runs the pending owner action, then either ends the Run
   * (approval, expiry) or returns it to the wait.
   */
  const reviewTurn = async (ctx: RunContext, action: "owner" | "expire"): Promise<RunOutcome> => {
    if (action === "expire") {
      return ctx.stage("review", async () => {
        ctx.event("debrief_expired", { reason: MEETING_DEBRIEF_EXPIRED_REASON });
        return { status: "skipped", reason: MEETING_DEBRIEF_EXPIRED_REASON };
      });
    }
    const transcriptId = ctx.meta().externalId ?? null;
    if (!transcriptId) {
      throw new Error("Debrief Run has no transcript identity");
    }
    const record = deps.catalog.getTranscript(transcriptId);
    /* The Catalog lost the record mid-review: the Debrief's source is gone,
       so the Run ends skipped the same way an associate-stage loss does. */
    if (!record) {
      return { status: "skipped", reason: "transcript_not_in_catalog" };
    }
    const state = await ctx.stage("review", async () => ensureReviewState(ctx, record));
    if (state.approval) {
      throw new Error("Debrief Run was already approved");
    }

    const request = state.request;
    if (request?.kind === "regenerate") {
      // ADR-0037: the regeneration is one audited Stage, and its model call
      // sees exactly what every other generation saw — the immutable record
      // and the Catalog's review state. The replaced value is not an input.
      await ctx.stage("regenerate", async () => {
        const debrief = await extract(ctx, record);
        const merged = mergeRegeneratedField(currentDebrief(ctx), request.field, debrief);
        storeResult(ctx, merged, transcriptId);
        const next: MeetingDebriefReviewState = {
          ...state,
          review: request.field === "actionItems" ? { droppedActionItems: [] } : state.review,
          request: null,
        };
        ctx.writeFile("review.json", serializeReviewState(next));
        ctx.event("debrief_regenerated", { field: request.field });
        return merged;
      });
      // Back to the wait. Any owner touch — approval request, regeneration —
      // restarts the unreviewed window the thirty-day clock measures.
      await ctx.stage("review", async () => {
        wait(ctx);
      });
    }

    if (request?.kind === "approve") {
      return ctx.stage("review", async () => {
        const blockers = approvalBlockers(state, gate);
        if (blockers.length > 0) {
          /* The Run keeps waiting: an approval refused here must not end a
             Debrief the owner still has on screen. The host route already
             refuses synchronously with the same blockers; this is the
             durable authority re-asserting against races. */
          ctx.event("debrief_approval_refused", { blockers });
          wait(ctx);
        }
        const approvedAt = now().toISOString();
        const locked: MeetingDebriefReviewState = {
          ...state,
          request: null,
          approval: { approvedAt },
        };
        ctx.writeFile("review.json", serializeReviewState(locked));
        const recipientCount = locked.roster.entries.length + locked.recipients.additional.length;
        ctx.event("debrief_approved", { approvedAt, recipientCount });
        return {
          status: "done",
          summary: `Approved with ${recipientCount} recipient${recipientCount === 1 ? "" : "s"}`,
          detail: { transcriptId, rosterStatus: rosterStatusOf(record), approved: true },
        };
      });
    }

    // No pending action: recovery or a stray resume — return to the wait.
    await ctx.stage("review", async () => {
      wait(ctx);
    });
    /* `wait` never returns; this line only satisfies the type checker. */
    throw new Error("unreachable");
  };

  return {
    id: MEETING_DEBRIEF_MODULE_ID,
    version: MEETING_DEBRIEF_MODULE_VERSION,

    failureHint(stage: string, reason: string): string {
      if (stage === "associate") return "The Transcript Catalog has no record for this Debrief.";
      if (stage === "extract" || stage === "regenerate") {
        return reason === "extraction failed after 3 attempts"
          ? "Extraction failed after 3 attempts."
          : "Extraction failed. Retry to re-run it.";
      }
      if (stage === "review") return "Review could not complete. Retry to resume it.";
      return reason;
    },

    planRetry(meta) {
      if (meta.status !== "failed" || !meta.failedStage) return null;
      if (meta.failedStage === "associate") {
        return {
          fromStage: meta.failedStage,
          reason: "failed_stage_is_safe_to_repeat",
          input: { kind: "resume", fromStage: meta.failedStage },
        };
      }
      if (meta.failedStage === "extract") {
        return {
          fromStage: "extract",
          reason: "failed_stage_is_safe_to_repeat",
          input: { kind: "resume", fromStage: "extract" },
          resetAttempts: true,
          discard: ["result.json"],
        };
      }
      if (meta.failedStage === "regenerate" || meta.failedStage === "review") {
        return {
          fromStage: "review",
          reason: "failed_stage_is_safe_to_repeat",
          input: { kind: "review", action: "owner" },
        };
      }
      return null;
    },

    planRecovery(state) {
      if (state.status !== "pending" && state.status !== "running") return null;
      if (state.files.includes("review.json") || state.files.includes("result.json")) {
        return {
          fromStage: "review",
          reason: state.files.includes("review.json")
            ? "debrief_review_survived_restart"
            : "debrief_result_survived_restart",
          input: { kind: "review", action: "owner" },
        };
      }
      return {
        fromStage: "associate",
        reason: "debrief_survived_restart",
        input: { kind: "resume", fromStage: "associate" },
      };
    },

    /** What continuing one of this Module's blocked review Runs means (ADR-0020). */
    planResume(meta) {
      if (meta.status !== "blocked" || !meta.wait) return null;
      const due =
        meta.wait.timeout.kind === "at" && Date.parse(meta.wait.timeout.at) <= now().getTime();
      if (due) {
        return {
          fromStage: meta.wait.stage,
          reason: "review_window_elapsed",
          input: { kind: "review", action: "expire" },
        };
      }
      return {
        fromStage: meta.wait.stage,
        reason: "owner_review_action",
        input: { kind: "review", action: "owner" },
      };
    },

    async run(ctx: RunContext, input: DebriefInput): Promise<RunOutcome> {
      if (input.kind === "review") {
        return reviewTurn(ctx, input.action);
      }

      const transcriptId =
        input.kind === "fresh" ? input.transcriptId : (ctx.meta().externalId ?? null);
      if (!transcriptId) {
        throw new Error("Debrief Run has no transcript identity");
      }

      // associate — consume the immutable record and the Catalog's review
      // state. Association stays live in the Catalog: later Calendar links
      // prefill the surfaces that read the record, not a frozen copy.
      const record = await ctx.stage("associate", async (): Promise<TranscriptRecord | null> => {
        const record = deps.catalog.getTranscript(transcriptId);
        if (!record) return null;
        const identity = deps.identity.reviewFor(transcriptId);
        ctx.event("association_consumed", {
          linked: record.occurrence !== null,
          occurrenceKey: record.occurrence?.occurrenceKey ?? null,
          rosterSize: record.roster.length,
          mentions: identity.mentions.length,
        });
        return record;
      });
      if (!record) {
        return { status: "skipped", reason: "transcript_not_in_catalog" };
      }

      // extract — the structured retrospective, from the stored artifact.
      await ctx.stage("extract", async () => {
        const debrief = await extract(ctx, record);
        storeResult(ctx, debrief, transcriptId);
        ctx.event("debrief_extracted", {
          decisions: debrief.decisions.length,
          actionItems: debrief.actionItems.length,
          openQuestions: debrief.openQuestions.length,
        });
        return debrief;
      });

      // review — the durable owner wait (ADR-0038). The Run blocks against a
      // 30-day wait record; approval or regeneration resumes it, the clock
      // expires it. The summary the list will keep showing across the wait
      // is the Module's own line about what it extracted.
      await ctx.stage("review", async () => {
        ensureReviewState(ctx, record);
        ctx.event("debrief_review_started", {
          rosterStatus: rosterStatusOf(record),
        });
        wait(ctx);
      });
      /* `wait` never returns; this line only satisfies the type checker. */
      throw new Error("unreachable");
    },
  };
}
