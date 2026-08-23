import {
  type ExtractionResult,
  type RunMeta,
  type RunSourceType,
  normalizeExtractionResult,
} from "@chief-of-staff-demo/shared";
import { type CompleteJson } from "../llm/providers.js";
import { buildExtractionMessages, type RunPromptContext } from "../llm/prompt.js";
import { googleFailureHint, type GoogleConnection } from "../google/connection.js";
import { SourceError, convertToText } from "../text/convert.js";
import type { RunContext, RunHandle, Runs } from "../runs.js";

const MAX_EXTRACT_ATTEMPTS = 3;

export interface RunSourceSpec {
  type: RunSourceType;
  fileName: string;
  bytes?: Buffer;
  /** Pre-converted transcript text (Fireflies intake). */
  text?: string;
  sourceUrl?: string | null;
  externalId?: string | null;
  context?: RunContext;
}

/** What a Run needs from the Google connection: a surface, and a verdict on a failure. */
export type GoogleAccess = Pick<GoogleConnection, "outputs" | "observe">;

export interface PipelineDeps {
  /** Constructed once by the Shell: the run directory has one owner. */
  runs: Runs;
  /** Fresh per attempt so config edits apply without a restart. */
  getCompleteJson: () => CompleteJson;
  /** Provider/model recorded on extract_attempt events for diagnosis. */
  getLlmInfo: () => { provider: string; model: string };
  google: GoogleAccess;
  getTasklistName: () => string;
  log?: (message: string) => void;
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

export class RunNotFoundError extends Error {
  constructor(runId: string) {
    super(`Run not found: ${runId}`);
    this.name = "RunNotFoundError";
  }
}

export class RunNotRetryableError extends Error {
  constructor(runId: string) {
    super(`Run is not retryable: ${runId}`);
    this.name = "RunNotRetryableError";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failureHintFor(stage: string, reason: string): string {
  if (stage === "convert") return "This file could not be converted to text.";
  if (stage === "outputs") {
    return "Output creation failed. Retry, or check the events below.";
  }
  return reason === "extraction failed after 3 attempts"
    ? "Extraction failed after 3 attempts."
    : "Extraction failed. Retry to re-run it.";
}

export class Pipeline {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly runs: Runs;

  constructor(private readonly deps: PipelineDeps) {
    this.runs = deps.runs;
  }

  /** Resolves when every enqueued job has settled (test seam). */
  async idle(): Promise<void> {
    await this.queue;
  }

  /**
   * Create the run on disk (meta, context, transcript) and enqueue
   * processing. A conversion failure still produces a visible failed run.
   */
  async startRun(spec: RunSourceSpec): Promise<string> {
    const run = this.runs.create({
      source: spec.type,
      fileName: spec.fileName,
      sourceUrl: spec.sourceUrl ?? null,
      externalId: spec.externalId ?? null,
      context: {
        meetingDate: spec.context?.meetingDate ?? meetingDateFromFileName(spec.fileName),
        attendees: spec.context?.attendees ?? [],
      },
    });
    try {
      const text = await this.stage(run, "convert", async () => {
        try {
          return spec.text ?? (await convertToText(spec.fileName, spec.bytes ?? Buffer.alloc(0)));
        } catch (err) {
          throw err instanceof SourceError ? new Error(`${err.code}: ${err.message}`) : err;
        }
      });
      run.writeTranscript(text);
      this.enqueue(() => this.processRun(run.id));
    } catch {
      this.deps.log?.(`Run ${run.id} failed to convert ${spec.fileName}`);
    }
    return run.id;
  }

  /** Re-run a failed run: extraction from scratch, or outputs from cached result. */
  async retryRun(id: string): Promise<RunMeta> {
    const run = this.runs.open(id);
    if (!run) {
      throw new RunNotFoundError(id);
    }
    const meta = run.read();
    /* The policy is this Module's: `convert` reads the uploaded bytes, which the
       Shell does not keep, so there is nothing to re-run. */
    if (meta.status !== "failed" || !meta.failedStage || meta.failedStage === "convert") {
      throw new RunNotRetryableError(id);
    }
    const stage = meta.failedStage;
    if (stage === "extract") {
      run.resetAttempts();
      run.deleteResult();
    }
    const reopened = run.reopen(stage);
    this.enqueue(() => (stage === "outputs" ? this.processRun(id, "outputs") : this.processRun(id)));
    return reopened;
  }

  private enqueue(job: () => Promise<void>): void {
    this.queue = this.queue
      .then(job)
      .catch((error) => {
        this.deps.log?.(`Pipeline job crashed: ${errorMessage(error)}`);
      });
  }

  private async stage<T>(run: RunHandle, name: string, fn: () => Promise<T>): Promise<T> {
    run.started(name);
    try {
      return await fn();
    } catch (error) {
      this.failRun(run, name, errorMessage(error));
      throw error;
    }
  }

  /** `hint` overrides the stage default; `flags.connectionCaused` records (D6)
   *  that reconnecting, not retrying, is the fix. */
  private failRun(
    run: RunHandle,
    stage: string,
    reason: string,
    hint?: string,
    flags?: { connectionCaused?: boolean }
  ): void {
    run.failed(stage, reason, hint ?? failureHintFor(stage, reason), flags);
  }

  private async processRun(id: string, resumeOutputs?: "outputs"): Promise<void> {
    const run = this.runs.open(id);
    if (!run) {
      return;
    }
    const context = run.readContext();
    try {
      if (resumeOutputs !== "outputs") {
        const result = await this.stage(run, "extract", () => this.extract(run, context));
        if (!result.isTranscript) {
          run.finished({ status: "skipped", reason: result.skipReason });
          return;
        }
        await this.stage(run, "outputs", () => this.createOutputs(run, result));
        return;
      }
      const cached = run.readResult();
      if (!cached) {
        this.failRun(run, "extract", "retry found no cached result");
        return;
      }
      await this.stage(run, "outputs", () => this.createOutputs(run, cached));
    } catch {
      // Already recorded by the stage wrapper; swallow so the queue doesn't log a crash.
    }
  }

  private async extract(run: RunHandle, context: RunContext): Promise<ExtractionResult> {
    const meta = run.read();
    let parsed: ExtractionResult | null = null;
    for (let round = 1; round <= MAX_EXTRACT_ATTEMPTS; round++) {
      const attempt = run.attemptStarted();
      const llm = this.deps.getLlmInfo();
      run.appendEvent("extract_attempt", { attempt, provider: llm.provider, model: llm.model });
      try {
        const complete = this.deps.getCompleteJson();
        const promptContext: RunPromptContext = {
          fileName: meta.fileName,
          sourceId: meta.externalId ?? meta.id,
          sourceUrl: meta.sourceUrl,
          meetingDate: context.meetingDate,
          attendees: context.attendees,
        };
        parsed = normalizeExtractionResult(await complete(buildExtractionMessages(promptContext, run.readTranscript())));
        run.appendEvent("extract_ok", { attempt });
        break;
      } catch (error) {
        run.appendEvent("extract_error", { attempt, error: errorMessage(error) });
        parsed = null;
      }
    }
    if (!parsed) {
      throw new Error(`extraction failed after ${MAX_EXTRACT_ATTEMPTS} attempts`);
    }
    const result: ExtractionResult = {
      ...parsed,
      sourceId: meta.externalId ?? meta.id,
      sourceFileName: meta.fileName,
      sourceUrl: meta.sourceUrl,
      processedAt: new Date().toISOString(),
    };
    run.writeResult(result);
    return result;
  }

  /**
   * A rejected grant is not one bad item: every remaining call would fail the
   * same way. Record what it proves about the connection and stop the batch.
   */
  private failedOnConnection(run: RunHandle, error: unknown): boolean {
    const state = this.deps.google.observe(error);
    if (!state) {
      return false;
    }
    run.appendEvent("google_unavailable", { state, error: errorMessage(error) });
    this.failRun(run, "outputs", `google_${state}`, googleFailureHint(state), {
      connectionCaused: true,
    });
    return true;
  }

  private async createOutputs(run: RunHandle, result: ExtractionResult): Promise<void> {
    const access = this.deps.google.outputs();
    if (!access.ok) {
      run.appendEvent("google_unavailable", { state: access.state });
      this.failRun(run, "outputs", `google_${access.state}`, googleFailureHint(access.state), {
        connectionCaused: true,
      });
      return;
    }
    const google = access.outputs;

    let tasklistId: string;
    try {
      tasklistId = await google.findOrCreateTasklist(this.deps.getTasklistName());
    } catch (error) {
      if (this.failedOnConnection(run, error)) {
        return;
      }
      this.failRun(run, "outputs", `tasklist: ${errorMessage(error)}`);
      return;
    }

    let taskErrors = 0;
    let draftErrors = 0;
    // Per-item try/catch: one bad item never kills the batch (drainOutbox parity).
    for (const task of result.tasks) {
      try {
        const { googleId, webViewLink } = await google.createTask(tasklistId, task, result);
        run.appendEvent("google_task_created", { title: task.title, googleId, webViewLink });
      } catch (error) {
        if (this.failedOnConnection(run, error)) {
          return;
        }
        taskErrors += 1;
        run.appendEvent("google_task_error", { title: task.title, error: errorMessage(error) });
      }
    }
    for (const draft of result.drafts) {
      try {
        const googleId = await google.createDraft(draft);
        run.appendEvent("gmail_draft_created", { subject: draft.subject, googleId });
      } catch (error) {
        if (this.failedOnConnection(run, error)) {
          return;
        }
        draftErrors += 1;
        run.appendEvent("gmail_draft_error", { subject: draft.subject, error: errorMessage(error) });
      }
    }

    run.finished({
      status: "done",
      detail: {
        tasks: result.tasks.length,
        drafts: result.drafts.length,
        taskErrors,
        draftErrors,
      },
    });
  }
}
