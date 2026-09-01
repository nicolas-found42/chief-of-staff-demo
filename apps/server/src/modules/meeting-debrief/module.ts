import type {
  MeetingDebriefExtraction,
  MeetingDebriefRunResult,
  TranscriptRecord,
} from "@chief-of-staff-demo/shared";
import {
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
import { buildDebriefMessages, resolveActionItemOwners } from "./extraction.js";

export type {
  DebriefCatalogReader,
  DebriefExtractInput,
  DebriefIdentityReviewReader,
} from "./deps.js";

const MAX_EXTRACT_ATTEMPTS = 3;

/** The Module's input: fresh from the Catalog's mining hand-off, or a resume. */
export type DebriefInput =
  { kind: "fresh"; transcriptId: string } | { kind: "resume"; fromStage: "associate" | "extract" };

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
}

/** How the Run's association stands, read from the immutable record itself. */
function rosterStatusOf(record: TranscriptRecord): "prefilled" | "requires_confirmation" {
  return record.occurrence !== null && record.roster.length > 0
    ? "prefilled"
    : "requires_confirmation";
}

function debriefSummary(
  debrief: MeetingDebriefExtraction,
  rosterStatus: "prefilled" | "requires_confirmation",
): string {
  const counts = [
    `${debrief.decisions.length} decision${debrief.decisions.length === 1 ? "" : "s"}`,
    `${debrief.actionItems.length} action item${debrief.actionItems.length === 1 ? "" : "s"}`,
    `${debrief.openQuestions.length} open question${debrief.openQuestions.length === 1 ? "" : "s"}`,
  ].join(", ");
  return `${counts} — ${rosterStatus === "prefilled" ? "ready for review" : "roster confirmation required"}`;
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

/**
 * Meeting Debrief v1 — two fixed Stages (issue #139). The review wait, the
 * approval-gated Gmail draft, and the owner Tasks are later slices: this
 * Module receives no outward-write capability at all, so a Debrief Run
 * structurally cannot write one.
 */
export function meetingDebriefModule(deps: MeetingDebriefModuleDeps): ShellModule<DebriefInput> {
  const now = deps.now ?? (() => new Date());

  const extract = async (
    ctx: RunContext,
    record: TranscriptRecord,
  ): Promise<MeetingDebriefExtraction> => {
    const identity = deps.identity.reviewFor(record.id);
    if (deps.extract) {
      return deps.extract({ record, identity });
    }
    return extractWithModel(ctx, record, identity, deps);
  };

  return {
    id: MEETING_DEBRIEF_MODULE_ID,
    version: MEETING_DEBRIEF_MODULE_VERSION,

    failureHint(stage: string, reason: string): string {
      if (stage === "associate") return "The Transcript Catalog has no record for this Debrief.";
      if (stage === "extract") {
        return reason === "extraction failed after 3 attempts"
          ? "Extraction failed after 3 attempts."
          : "Extraction failed. Retry to re-run it.";
      }
      return reason;
    },

    planRetry(meta) {
      if (meta.status !== "failed" || !meta.failedStage) return null;
      if (meta.failedStage !== "associate" && meta.failedStage !== "extract") return null;
      return {
        fromStage: meta.failedStage,
        reason: "failed_stage_is_safe_to_repeat",
        input: { kind: "resume", fromStage: meta.failedStage },
        ...(meta.failedStage === "extract"
          ? { resetAttempts: true, discard: ["result.json"] }
          : {}),
      };
    },

    planRecovery(state) {
      if (state.status !== "pending" && state.status !== "running") return null;
      const fromStage = state.files.includes("result.json") ? "extract" : "associate";
      return {
        fromStage,
        reason: state.files.includes("result.json")
          ? "debrief_result_survived_restart"
          : "debrief_survived_restart",
        input: { kind: "resume", fromStage },
      };
    },

    async run(ctx: RunContext, input: DebriefInput): Promise<RunOutcome> {
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
      const resolved = await ctx.stage("extract", async () => {
        const debrief = await extract(ctx, record);
        const withOwners = resolveActionItemOwners(debrief, deps.identity.reviewFor(transcriptId));
        const result: MeetingDebriefRunResult = {
          version: 1,
          transcriptId,
          extractedAt: now().toISOString(),
          debrief: withOwners,
        };
        ctx.writeFile("result.json", JSON.stringify(result, null, 2) + "\n");
        ctx.event("debrief_extracted", {
          decisions: withOwners.decisions.length,
          actionItems: withOwners.actionItems.length,
          openQuestions: withOwners.openQuestions.length,
        });
        return withOwners;
      });
      const rosterStatus = rosterStatusOf(record);

      return {
        status: "done",
        summary: debriefSummary(resolved, rosterStatus),
        detail: { transcriptId, rosterStatus },
      };
    },
  };
}
