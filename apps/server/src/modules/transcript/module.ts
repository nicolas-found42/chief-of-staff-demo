import {
  type ExtractionResult,
  NormalizedExtractionResultSchema,
} from "@chief-of-staff-demo/shared";
import type { RunOutcome } from "../../runs.js";
import type { RetryPlan, RunContext, ShellModule } from "../../engine/module.js";
import { connectionFailure, connectionUnavailable, errorMessage } from "../../engine/failure.js";
import type { GoogleConnection } from "../../google/connection.js";
import {
  buildExtractionMessages,
  type RunPromptContext,
  type TranscriptRunContext,
} from "../../llm/prompt.js";
import { type CompleteJson } from "../../llm/providers.js";
import {
  modelDiagnosticEventDetail,
  modelBoundaryDiagnostic,
  parseResultShape,
  resultShapeDiagnostic,
} from "../../llm/failure.js";
import { convertToText } from "../../text/convert.js";
import { conversionStageFailure } from "../../text/failure.js";

const MAX_EXTRACT_ATTEMPTS = 3;

export const TRANSCRIPT_MODULE_ID = "transcript";
export const TRANSCRIPT_MODULE_VERSION = 1;

/** What an Intake hands the Module for a new Run. */
export interface RunSourceSpec {
  intake: string;
  fileName: string;
  bytes?: Buffer;
  /** Pre-converted transcript text (Fireflies intake). */
  text?: string;
  sourceUrl?: string | null;
  externalId?: string | null;
  context?: TranscriptRunContext;
}

/**
 * The Module's own input: a fresh Run starts from what the Intake found, a
 * retried one from what is already in the Run's own files.
 */
export type TranscriptInput =
  { kind: "fresh"; spec: RunSourceSpec } | { kind: "resume"; fromStage: "extract" | "outputs" };

/** What a Run needs from the Google connection: a surface, and a verdict on a failure. */
export type GoogleAccess = Pick<GoogleConnection, "outputs" | "observe">;

export interface TranscriptDeps {
  /** Fresh per attempt so config edits apply without a restart. */
  getCompleteJson: () => CompleteJson;
  /** Provider/model recorded on extract_attempt events for diagnosis. */
  getLlmInfo: () => { provider: string; model: string };
  google: GoogleAccess;
  getTasklistName: () => string;
}

const FILE_TIMESTAMP = /(\d{4}-\d{2}-\d{2})T\d{2}[-:]/;

/**
 * Fireflies exports embed the meeting timestamp in the file name
 * (`…-2026-06-18T13-00-00.000Z.json`). Recovering the date lets relative
 * deadlines ("by Monday") resolve against the meeting, not upload time.
 */
export function meetingDateFromFileName(fileName: string): string | null {
  const match = FILE_TIMESTAMP.exec(fileName);
  return match ? (match[1] ?? null) : null;
}

/**
 * The one line this Module's Runs show in the Runs list. A noun phrase about
 * what landed in the world, counted from what Google actually accepted rather
 * than from what was extracted.
 */
function transcriptSummary(tasks: number, drafts: number): string {
  const parts: string[] = [];
  if (tasks > 0) {
    parts.push(tasks === 1 ? "1 task" : `${tasks} tasks`);
  }
  if (drafts > 0) {
    parts.push(drafts === 1 ? "1 draft" : `${drafts} drafts`);
  }
  return parts.length > 0 ? parts.join(", ") : "Nothing created";
}

function readContext(ctx: RunContext): TranscriptRunContext {
  const raw = ctx.readFile("context.json");
  if (!raw) {
    return { meetingDate: null, attendees: [] };
  }
  try {
    const parsed = JSON.parse(raw) as TranscriptRunContext;
    return {
      meetingDate: parsed.meetingDate ?? null,
      attendees: Array.isArray(parsed.attendees) ? parsed.attendees : [],
    };
  } catch {
    return { meetingDate: null, attendees: [] };
  }
}

/**
 * Transcript → Tasks, as a Module: three Stages it names and orders itself
 * (`convert`, `extract`, `outputs`), the policy for retrying each, and the one
 * line its Runs show in the Runs list. The Shell records all of it and reads
 * inside none of it.
 */
export function transcriptModule(deps: TranscriptDeps): ShellModule<TranscriptInput> {
  const extract = async (ctx: RunContext): Promise<ExtractionResult> => {
    const meta = ctx.meta();
    const context = readContext(ctx);
    let parsed: ExtractionResult | null = null;
    let lastFailure: unknown = null;
    for (let round = 1; round <= MAX_EXTRACT_ATTEMPTS; round++) {
      const attempt = ctx.attempt();
      const llm = deps.getLlmInfo();
      ctx.event("extract_attempt", { attempt, provider: llm.provider, model: llm.model });
      try {
        const complete = deps.getCompleteJson();
        const promptContext: RunPromptContext = {
          fileName: meta.fileName ?? "",
          sourceId: meta.externalId ?? meta.id,
          sourceUrl: meta.sourceUrl,
          meetingDate: context.meetingDate,
          attendees: context.attendees,
        };
        const raw = await complete(
          buildExtractionMessages(promptContext, ctx.readFile("transcript.txt") ?? ""),
        );
        parsed = parseResultShape("TranscriptExtraction", NormalizedExtractionResultSchema, raw);
        ctx.event("extract_ok", { attempt });
        break;
      } catch (error) {
        ctx.event("extract_error", {
          attempt,
          error: errorMessage(error),
          ...modelDiagnosticEventDetail(error),
        });
        lastFailure = error;
        parsed = null;
      }
    }
    if (!parsed) {
      if (
        modelBoundaryDiagnostic(lastFailure) !== null ||
        resultShapeDiagnostic(lastFailure) !== null
      ) {
        throw lastFailure;
      }
      throw new Error(`extraction failed after ${MAX_EXTRACT_ATTEMPTS} attempts`);
    }
    const result: ExtractionResult = {
      ...parsed,
      sourceId: meta.externalId ?? meta.id,
      sourceFileName: meta.fileName ?? "",
      sourceUrl: meta.sourceUrl,
      processedAt: new Date().toISOString(),
    };
    ctx.writeFile("result.json", JSON.stringify(result, null, 2) + "\n");
    return result;
  };

  const createOutputs = async (ctx: RunContext, result: ExtractionResult): Promise<RunOutcome> => {
    const access = deps.google.outputs();
    if (!access.ok) {
      throw connectionUnavailable(ctx, access.state);
    }
    const google = access.outputs;

    let tasklistId: string;
    try {
      tasklistId = await google.findOrCreateTasklist(deps.getTasklistName());
    } catch (error) {
      throw (
        connectionFailure(ctx, deps.google.observe, error) ??
        new Error(`tasklist: ${errorMessage(error)}`)
      );
    }

    let taskErrors = 0;
    let draftErrors = 0;
    // Per-item try/catch: one bad item never kills the batch (drainOutbox parity).
    for (const task of result.tasks) {
      try {
        const { googleId, webViewLink } = await google.createTask(tasklistId, task, result);
        ctx.event("google_task_created", { title: task.title, googleId, webViewLink });
      } catch (error) {
        const dead = connectionFailure(ctx, deps.google.observe, error);
        if (dead) {
          throw dead;
        }
        taskErrors += 1;
        ctx.event("google_task_error", { title: task.title, error: errorMessage(error) });
      }
    }
    for (const draft of result.drafts) {
      try {
        const googleId = await google.createDraft(draft);
        ctx.event("gmail_draft_created", { subject: draft.subject, googleId });
      } catch (error) {
        const dead = connectionFailure(ctx, deps.google.observe, error);
        if (dead) {
          throw dead;
        }
        draftErrors += 1;
        ctx.event("gmail_draft_error", { subject: draft.subject, error: errorMessage(error) });
      }
    }

    return {
      status: "done",
      summary: transcriptSummary(
        result.tasks.length - taskErrors,
        result.drafts.length - draftErrors,
      ),
      detail: {
        tasks: result.tasks.length,
        drafts: result.drafts.length,
        taskErrors,
        draftErrors,
      },
    };
  };

  return {
    id: TRANSCRIPT_MODULE_ID,
    version: TRANSCRIPT_MODULE_VERSION,

    failureHint(stage: string, reason: string): string {
      if (stage === "convert") return "This file could not be converted to text.";
      if (stage === "outputs") {
        return "Output creation failed. Retry, or check the events below.";
      }
      return reason === "extraction failed after 3 attempts"
        ? "Extraction failed after 3 attempts."
        : "Extraction failed. Retry to re-run it.";
    },

    planRetry(meta): RetryPlan<TranscriptInput> | null {
      /* The policy is this Module's: `convert` reads the uploaded bytes, which
         the Shell does not keep, so there is nothing to re-run. */
      if (meta.status !== "failed" || !meta.failedStage || meta.failedStage === "convert") {
        return null;
      }
      if (meta.failedStage === "outputs") {
        return {
          fromStage: "outputs",
          reason: "extracted_result_is_durable",
          input: { kind: "resume", fromStage: "outputs" },
        };
      }
      return {
        fromStage: meta.failedStage,
        reason: "extraction_restarts_from_clean_result",
        input: { kind: "resume", fromStage: "extract" },
        resetAttempts: true,
        discard: ["result.json"],
      };
    },

    planRecovery(state) {
      if (
        (state.status !== "pending" && state.status !== "running") ||
        !state.files.includes("transcript.txt")
      ) {
        return null;
      }
      const fromStage = state.files.includes("result.json") ? "outputs" : "extract";
      return {
        fromStage,
        reason: state.files.includes("result.json")
          ? "extracted_result_survived_restart"
          : "transcript_survived_restart",
        input: { kind: "resume", fromStage },
      };
    },

    async run(ctx, input): Promise<RunOutcome> {
      if (input.kind === "fresh") {
        const spec = input.spec;
        await ctx.stage("convert", async () => {
          ctx.writeFile(
            "context.json",
            JSON.stringify(
              {
                meetingDate: spec.context?.meetingDate ?? meetingDateFromFileName(spec.fileName),
                attendees: spec.context?.attendees ?? [],
              },
              null,
              2,
            ) + "\n",
          );
          let text: string;
          const sourceBytes = spec.bytes ?? Buffer.alloc(0);
          try {
            text = spec.text ?? (await convertToText(spec.fileName, sourceBytes));
          } catch (err) {
            throw conversionStageFailure(err, spec.fileName, sourceBytes);
          }
          ctx.writeFile("transcript.txt", text);
        });
      }

      if (input.kind === "fresh" || input.fromStage === "extract") {
        const result = await ctx.stage("extract", () => extract(ctx));
        if (!result.isTranscript) {
          return { status: "skipped", reason: result.skipReason };
        }
        return await ctx.stage("outputs", () => createOutputs(ctx, result));
      }

      /* Resuming outputs from the result already extracted: a retry must not
         mix a second extraction into the same Run. */
      const raw = ctx.readFile("result.json");
      let cached: ExtractionResult | null = null;
      if (raw) {
        try {
          cached = JSON.parse(raw) as ExtractionResult;
        } catch {
          cached = null;
        }
      }
      if (!cached) {
        /* Unreachable while `extract` writes the result before `outputs` can
           fail. Recorded against `extract` anyway, so the retry that follows
           re-runs extraction instead of looping on a file that is not there. */
        return await ctx.stage("extract", async (): Promise<RunOutcome> => {
          throw new Error("retry found no cached result");
        });
      }
      return await ctx.stage("outputs", () => createOutputs(ctx, cached));
    },
  };
}
