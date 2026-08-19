import {
  type ExtractionResult,
  type RunMeta,
  type RunSourceType,
  normalizeExtractionResult,
} from "@transcript-tasks/shared";
import { type CompleteJson } from "../llm/providers.js";
import { buildExtractionMessages, type RunPromptContext } from "../llm/prompt.js";
import type { GoogleOutputs } from "../google/outputs.js";
import { SourceError, convertToText } from "../text/convert.js";
import { openRuns, type RunContext, type RunHandle, type Runs } from "../runs.js";

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

export interface PipelineDeps {
  workspaceDir: string;
  /** Fresh per attempt so config edits apply without a restart. */
  getCompleteJson: () => CompleteJson;
  /** Provider/model recorded on extract_attempt events for diagnosis. */
  getLlmInfo: () => { provider: string; model: string };
  getGoogle: () => GoogleOutputs | null;
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
    super(`Run is not in a failed state: ${runId}`);
    this.name = "RunNotRetryableError";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class Pipeline {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly runs: Runs;

  constructor(private readonly deps: PipelineDeps) {
    this.runs = openRuns(deps.workspaceDir);
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
    const meta = run.readMeta();

    let text: string | null = null;
    try {
      text = spec.text ?? (await convertToText(spec.fileName, spec.bytes ?? Buffer.alloc(0)));
    } catch (err) {
      const reason =
        err instanceof SourceError ? `${err.code}: ${err.message}` : errorMessage(err);
      meta.status = "failed";
      meta.failedStage = "extract";
      run.writeMeta(meta);
      run.appendEvent("run_failed", { stage: "extract", reason });
      this.deps.log?.(`Run ${run.id} failed to convert ${spec.fileName}: ${reason}`);
      return run.id;
    }
    run.writeTranscript(text);
    this.enqueue(() => this.processRun(run.id));
    return run.id;
  }

  /** Re-run a failed run: extraction from scratch, or outputs from cached result. */
  async retryRun(id: string): Promise<RunMeta> {
    const run = this.runs.open(id);
    if (!run) {
      throw new RunNotFoundError(id);
    }
    const meta = run.readMeta();
    if (meta.status !== "failed" || !meta.failedStage) {
      throw new RunNotRetryableError(id);
    }
    const stage = meta.failedStage;
    meta.status = "pending";
    meta.failedStage = null;
    meta.skipReason = null;
    if (stage === "extract") {
      meta.attempts = 0;
      run.deleteResult();
    }
    run.writeMeta(meta);
    this.enqueue(() => (stage === "outputs" ? this.processRun(id, "outputs") : this.processRun(id)));
    return meta;
  }

  private enqueue(job: () => Promise<void>): void {
    this.queue = this.queue
      .then(job)
      .catch((error) => {
        this.deps.log?.(`Pipeline job crashed: ${errorMessage(error)}`);
      });
  }

  private async processRun(id: string, resumeOutputs?: "outputs"): Promise<void> {
    const run = this.runs.open(id);
    if (!run) {
      return;
    }
    const meta = run.readMeta();
    const context = run.readContext();

    if (resumeOutputs !== "outputs") {
      meta.status = "extracting";
      run.writeMeta(meta);
      let parsed: ExtractionResult | null = null;
      for (let attempt = 1; attempt <= MAX_EXTRACT_ATTEMPTS; attempt++) {
        meta.attempts = attempt;
        run.writeMeta(meta);
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
          const messages = buildExtractionMessages(promptContext, run.readTranscript());
          parsed = normalizeExtractionResult(await complete(messages));
          run.appendEvent("extract_ok", { attempt });
          break;
        } catch (error) {
          run.appendEvent("extract_error", { attempt, error: errorMessage(error) });
          parsed = null;
        }
      }
      if (!parsed) {
        this.failRun(run, meta, "extract", "extraction failed after 3 attempts");
        return;
      }
      // Identity fields are authoritative server-side values, never LLM output.
      const result: ExtractionResult = {
        ...parsed,
        sourceId: meta.externalId ?? meta.id,
        sourceFileName: meta.fileName,
        sourceUrl: meta.sourceUrl,
        processedAt: new Date().toISOString(),
      };
      run.writeResult(result);
      meta.skipReason = result.skipReason;
      if (!result.isTranscript) {
        meta.status = "skipped";
        run.writeMeta(meta);
        run.appendEvent("classify_skipped", { skipReason: result.skipReason });
        run.appendEvent("run_done", { status: "skipped" });
        return;
      }
      await this.createOutputs(run, meta, result);
      return;
    }

    const cached = run.readResult();
    if (!cached) {
      this.failRun(run, meta, "extract", "retry found no cached result");
      return;
    }
    await this.createOutputs(run, meta, cached);
  }

  private async createOutputs(
    run: RunHandle,
    meta: RunMeta,
    result: ExtractionResult
  ): Promise<void> {
    meta.status = "creating-outputs";
    run.writeMeta(meta);

    const google = this.deps.getGoogle();
    if (!google) {
      run.appendEvent("google_not_connected");
      this.failRun(run, meta, "outputs", "google_not_connected");
      return;
    }

    let tasklistId: string;
    try {
      tasklistId = await google.findOrCreateTasklist(this.deps.getTasklistName());
    } catch (error) {
      this.failRun(run, meta, "outputs", `tasklist: ${errorMessage(error)}`);
      return;
    }

    let taskErrors = 0;
    let draftErrors = 0;
    // Per-item try/catch: one bad item never kills the batch (drainOutbox parity).
    for (const task of result.tasks) {
      try {
        const googleId = await google.createTask(tasklistId, task, result);
        run.appendEvent("google_task_created", { title: task.title, googleId });
      } catch (error) {
        taskErrors += 1;
        run.appendEvent("google_task_error", { title: task.title, error: errorMessage(error) });
      }
    }
    for (const draft of result.drafts) {
      try {
        const googleId = await google.createDraft(draft);
        run.appendEvent("gmail_draft_created", { subject: draft.subject, googleId });
      } catch (error) {
        draftErrors += 1;
        run.appendEvent("gmail_draft_error", { subject: draft.subject, error: errorMessage(error) });
      }
    }

    meta.status = "done";
    meta.failedStage = null;
    run.writeMeta(meta);
    run.appendEvent("run_done", {
      status: "done",
      tasks: result.tasks.length,
      drafts: result.drafts.length,
      taskErrors,
      draftErrors,
    });
  }

  private failRun(
    run: RunHandle,
    meta: RunMeta,
    stage: "extract" | "outputs",
    reason: string
  ): void {
    meta.status = "failed";
    meta.failedStage = stage;
    run.writeMeta(meta);
    run.appendEvent("run_failed", { stage, reason });
  }
}
