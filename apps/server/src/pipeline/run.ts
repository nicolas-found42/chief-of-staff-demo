import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  type ExtractionResult,
  type RunDetail,
  type RunEvent,
  type RunEventType,
  type RunMeta,
  type RunSourceType,
  type RunSummary,
  normalizeExtractionResult,
} from "@transcript-tasks/shared";
import { type CompleteJson } from "../llm/providers.js";
import { buildExtractionMessages, type RunPromptContext } from "../llm/prompt.js";
import type { GoogleOutputs } from "../google/outputs.js";
import { isRunId, newRunId, workspaceLayout } from "../paths.js";
import { SourceError, convertToText } from "../text/convert.js";

const MAX_EXTRACT_ATTEMPTS = 3;

export interface RunAttendee {
  name: string;
  email: string | null;
}

export interface RunContext {
  meetingDate: string | null;
  attendees: RunAttendee[];
}

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

function writeMeta(runDir: string, meta: RunMeta): void {
  writeFileSync(join(runDir, "meta.json"), JSON.stringify(meta, null, 2) + "\n", "utf8");
}

function readMeta(runDir: string): RunMeta {
  return JSON.parse(readFileSync(join(runDir, "meta.json"), "utf8")) as RunMeta;
}

function appendEvent(
  runDir: string,
  type: RunEventType,
  detail?: Record<string, unknown>
): void {
  const event: RunEvent = { at: new Date().toISOString(), type };
  if (detail) {
    event.detail = detail;
  }
  appendFileSync(join(runDir, "events.jsonl"), JSON.stringify(event) + "\n", "utf8");
}

function readEvents(runDir: string): RunEvent[] {
  const path = join(runDir, "events.jsonl");
  if (!existsSync(path)) {
    return [];
  }
  const events: RunEvent[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    try {
      events.push(JSON.parse(line) as RunEvent);
    } catch {
      // Tolerate a torn final line rather than losing the whole timeline.
    }
  }
  return events;
}

function readResult(runDir: string): ExtractionResult | null {
  const path = join(runDir, "result.json");
  if (!existsSync(path)) {
    return null;
  }
  return JSON.parse(readFileSync(path, "utf8")) as ExtractionResult;
}

function readContext(runDir: string): RunContext {
  const path = join(runDir, "context.json");
  if (!existsSync(path)) {
    return { meetingDate: null, attendees: [] };
  }
  return JSON.parse(readFileSync(path, "utf8")) as RunContext;
}

function readTranscript(runDir: string): string {
  const path = join(runDir, "transcript.txt");
  if (!existsSync(path)) {
    return "";
  }
  return readFileSync(path, "utf8");
}

export class Pipeline {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: PipelineDeps) {}

  /** Resolves when every enqueued job has settled (test seam). */
  async idle(): Promise<void> {
    await this.queue;
  }

  /**
   * Create the run on disk (meta, context, transcript) and enqueue
   * processing. A conversion failure still produces a visible failed run.
   */
  async startRun(spec: RunSourceSpec): Promise<string> {
    const layout = workspaceLayout(this.deps.workspaceDir);
    mkdirSync(layout.runsDir, { recursive: true });
    const id = newRunId();
    const runDir = layout.runDir(id);
    mkdirSync(runDir);
    const meta: RunMeta = {
      id,
      createdAt: new Date().toISOString(),
      source: spec.type,
      fileName: spec.fileName,
      sourceUrl: spec.sourceUrl ?? null,
      externalId: spec.externalId ?? null,
      status: "pending",
      attempts: 0,
      failedStage: null,
      skipReason: null,
    };
    writeMeta(runDir, meta);
    writeFileSync(
      join(runDir, "context.json"),
      JSON.stringify(
        {
          meetingDate: spec.context?.meetingDate ?? meetingDateFromFileName(spec.fileName),
          attendees: spec.context?.attendees ?? [],
        },
        null,
        2
      ) + "\n",
      "utf8"
    );
    appendEvent(runDir, "created", { source: spec.type, fileName: spec.fileName });

    let text: string | null = null;
    try {
      text = spec.text ?? (await convertToText(spec.fileName, spec.bytes ?? Buffer.alloc(0)));
    } catch (err) {
      const reason =
        err instanceof SourceError ? `${err.code}: ${err.message}` : errorMessage(err);
      meta.status = "failed";
      meta.failedStage = "extract";
      writeMeta(runDir, meta);
      appendEvent(runDir, "run_failed", { stage: "extract", reason });
      this.deps.log?.(`Run ${id} failed to convert ${spec.fileName}: ${reason}`);
      return id;
    }
    writeFileSync(join(runDir, "transcript.txt"), text, "utf8");
    this.enqueue(() => this.processRun(id));
    return id;
  }

  /** Re-run a failed run: extraction from scratch, or outputs from cached result. */
  async retryRun(id: string): Promise<RunMeta> {
    const layout = workspaceLayout(this.deps.workspaceDir);
    if (!isRunId(id) || !existsSync(layout.runDir(id))) {
      throw new RunNotFoundError(id);
    }
    const runDir = layout.runDir(id);
    const meta = readMeta(runDir);
    if (meta.status !== "failed" || !meta.failedStage) {
      throw new RunNotRetryableError(id);
    }
    const stage = meta.failedStage;
    meta.status = "pending";
    meta.failedStage = null;
    meta.skipReason = null;
    if (stage === "extract") {
      meta.attempts = 0;
      rmSync(join(runDir, "result.json"), { force: true });
    }
    writeMeta(runDir, meta);
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
    const layout = workspaceLayout(this.deps.workspaceDir);
    const runDir = layout.runDir(id);
    const meta = readMeta(runDir);
    const context = readContext(runDir);

    if (resumeOutputs !== "outputs") {
      meta.status = "extracting";
      writeMeta(runDir, meta);
      let parsed: ExtractionResult | null = null;
      for (let attempt = 1; attempt <= MAX_EXTRACT_ATTEMPTS; attempt++) {
        meta.attempts = attempt;
        writeMeta(runDir, meta);
        const llm = this.deps.getLlmInfo();
        appendEvent(runDir, "extract_attempt", { attempt, provider: llm.provider, model: llm.model });
        try {
          const complete = this.deps.getCompleteJson();
          const promptContext: RunPromptContext = {
            fileName: meta.fileName,
            sourceId: meta.externalId ?? meta.id,
            sourceUrl: meta.sourceUrl,
            meetingDate: context.meetingDate,
            attendees: context.attendees,
          };
          const messages = buildExtractionMessages(promptContext, readTranscript(runDir));
          parsed = normalizeExtractionResult(await complete(messages));
          appendEvent(runDir, "extract_ok", { attempt });
          break;
        } catch (error) {
          appendEvent(runDir, "extract_error", { attempt, error: errorMessage(error) });
          parsed = null;
        }
      }
      if (!parsed) {
        this.failRun(runDir, meta, "extract", "extraction failed after 3 attempts");
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
      writeFileSync(join(runDir, "result.json"), JSON.stringify(result, null, 2) + "\n", "utf8");
      meta.skipReason = result.skipReason;
      if (!result.isTranscript) {
        meta.status = "skipped";
        writeMeta(runDir, meta);
        appendEvent(runDir, "classify_skipped", { skipReason: result.skipReason });
        appendEvent(runDir, "run_done", { status: "skipped" });
        return;
      }
      await this.createOutputs(runDir, meta, result);
      return;
    }

    const cached = readResult(runDir);
    if (!cached) {
      this.failRun(runDir, meta, "extract", "retry found no cached result");
      return;
    }
    await this.createOutputs(runDir, meta, cached);
  }

  private async createOutputs(
    runDir: string,
    meta: RunMeta,
    result: ExtractionResult
  ): Promise<void> {
    meta.status = "creating-outputs";
    writeMeta(runDir, meta);

    const google = this.deps.getGoogle();
    if (!google) {
      appendEvent(runDir, "google_not_connected");
      this.failRun(runDir, meta, "outputs", "google_not_connected");
      return;
    }

    let tasklistId: string;
    try {
      tasklistId = await google.findOrCreateTasklist(this.deps.getTasklistName());
    } catch (error) {
      this.failRun(runDir, meta, "outputs", `tasklist: ${errorMessage(error)}`);
      return;
    }

    let taskErrors = 0;
    let draftErrors = 0;
    // Per-item try/catch: one bad item never kills the batch (drainOutbox parity).
    for (const task of result.tasks) {
      try {
        const googleId = await google.createTask(tasklistId, task, result);
        appendEvent(runDir, "google_task_created", { title: task.title, googleId });
      } catch (error) {
        taskErrors += 1;
        appendEvent(runDir, "google_task_error", { title: task.title, error: errorMessage(error) });
      }
    }
    for (const draft of result.drafts) {
      try {
        const googleId = await google.createDraft(draft);
        appendEvent(runDir, "gmail_draft_created", { subject: draft.subject, googleId });
      } catch (error) {
        draftErrors += 1;
        appendEvent(runDir, "gmail_draft_error", { subject: draft.subject, error: errorMessage(error) });
      }
    }

    meta.status = "done";
    meta.failedStage = null;
    writeMeta(runDir, meta);
    appendEvent(runDir, "run_done", {
      status: "done",
      tasks: result.tasks.length,
      drafts: result.drafts.length,
      taskErrors,
      draftErrors,
    });
  }

  private failRun(
    runDir: string,
    meta: RunMeta,
    stage: "extract" | "outputs",
    reason: string
  ): void {
    meta.status = "failed";
    meta.failedStage = stage;
    writeMeta(runDir, meta);
    appendEvent(runDir, "run_failed", { stage, reason });
  }
}

function toSummary(meta: RunMeta, result: ExtractionResult | null): RunSummary {
  return {
    id: meta.id,
    createdAt: meta.createdAt,
    source: meta.source,
    fileName: meta.fileName,
    sourceUrl: meta.sourceUrl,
    status: meta.status,
    taskCount: result ? result.tasks.length : null,
  };
}

export function listRunSummaries(workspaceDir: string): RunSummary[] {
  const layout = workspaceLayout(workspaceDir);
  let entries: string[] = [];
  try {
    entries = readdirSync(layout.runsDir);
  } catch {
    return [];
  }
  const summaries: RunSummary[] = [];
  for (const entry of entries) {
    if (!isRunId(entry)) {
      continue;
    }
    const runDir = layout.runDir(entry);
    try {
      summaries.push(toSummary(readMeta(runDir), readResult(runDir)));
    } catch {
      // Incomplete run dir (e.g. crashed mid-write); skip it.
    }
  }
  summaries.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return summaries;
}

export function readRunDetail(workspaceDir: string, id: string): RunDetail | null {
  if (!isRunId(id)) {
    return null;
  }
  const layout = workspaceLayout(workspaceDir);
  const runDir = layout.runDir(id);
  if (!existsSync(runDir)) {
    return null;
  }
  const meta = readMeta(runDir);
  const result = readResult(runDir);
  return {
    ...toSummary(meta, result),
    attempts: meta.attempts,
    failedStage: meta.failedStage,
    skipReason: meta.skipReason,
    result,
    events: readEvents(runDir),
    transcript: readTranscript(runDir),
  };
}
