import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
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
} from "@chief-of-staff-demo/shared";
import { isRunId, newRunId, workspaceLayout } from "./paths.js";

export interface RunAttendee {
  name: string;
  email: string | null;
}

export interface RunContext {
  meetingDate: string | null;
  attendees: RunAttendee[];
}

/** How a Run ends. Both are terminal; `failed` has its own transition. */
export type RunOutcome =
  | { status: "done"; detail?: Record<string, unknown> }
  | { status: "skipped"; reason: string | null };

/**
 * One Run, as the things that can happen to it. Status and the event log are
 * written together by the transitions below, so no caller can move a Run
 * without the timeline saying so — the two disagreeing is what the Run detail
 * page renders side by side.
 *
 * A Module names the Stages and decides the policy (which are retryable, what a
 * failure means); this module only records what happened. See ADR-0009.
 */
export interface RunHandle {
  readonly id: string;
  /** A snapshot. Runs is the only writer, so a held copy is never authoritative. */
  read(): Readonly<RunMeta>;
  /** Enter a Stage: the Run is running, and the start is logged. */
  started(stage: string): void;
  /** Leave a Stage as failed, with the wording the failing module supplied. */
  failed(stage: string, reason: string, hint: string): void;
  /** End the Run. */
  finished(outcome: RunOutcome): void;
  /** Count one attempt at the current Stage; returns the new count. */
  attemptStarted(): number;
  /** Start counting attempts again, for a Stage the Module is re-running from scratch. */
  resetAttempts(): void;
  /** Back to pending with the failure cleared, ready to run again from `fromStage`. */
  reopen(fromStage: string): Readonly<RunMeta>;
  /** Module-named events. The Shell writes the Stage and status ones itself. */
  appendEvent(type: RunEventType, detail?: Record<string, unknown>): void;
  readResult(): ExtractionResult | null;
  writeResult(result: ExtractionResult): void;
  deleteResult(): void;
  readContext(): RunContext;
  readTranscript(): string;
  writeTranscript(text: string): void;
}

export interface NewRun {
  source: RunSourceType;
  fileName: string;
  sourceUrl: string | null;
  externalId: string | null;
  context: RunContext;
}

export interface Runs {
  create(input: NewRun): RunHandle;
  open(id: string): RunHandle | null;
  list(): RunSummary[];
  detail(id: string): RunDetail | null;
}

/**
 * Written to a sibling and renamed over the target: a torn `meta.json` is the
 * one failure that makes a Run vanish from the list rather than merely look
 * stale, and rename is atomic within a directory.
 */
function writeMeta(runDir: string, meta: RunMeta): void {
  const path = join(runDir, "meta.json");
  const temp = `${path}.tmp`;
  writeFileSync(temp, JSON.stringify(meta, null, 2) + "\n", "utf8");
  renameSync(temp, path);
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

class RunHandleImpl implements RunHandle {
  constructor(
    readonly id: string,
    private readonly dir: string
  ) {}

  read(): Readonly<RunMeta> {
    return readMeta(this.dir);
  }

  /** Every transition goes through here, so status and timeline cannot drift apart. */
  private transition(
    change: (meta: RunMeta) => void,
    events: { type: RunEventType; detail?: Record<string, unknown> }[]
  ): RunMeta {
    const meta = readMeta(this.dir);
    change(meta);
    writeMeta(this.dir, meta);
    for (const event of events) {
      appendEvent(this.dir, event.type, event.detail);
    }
    return meta;
  }

  started(stage: string): void {
    this.transition(
      (meta) => {
        meta.status = "running";
      },
      [{ type: "stage_started", detail: { stage } }]
    );
  }

  failed(stage: string, reason: string, hint: string): void {
    this.transition(
      (meta) => {
        meta.status = "failed";
        meta.failedStage = stage;
        meta.failureHint = hint;
      },
      [
        { type: "stage_failed", detail: { stage, error: reason } },
        { type: "run_failed", detail: { stage, reason } },
      ]
    );
  }

  finished(outcome: RunOutcome): void {
    if (outcome.status === "skipped") {
      this.transition(
        (meta) => {
          meta.status = "skipped";
          meta.skipReason = outcome.reason;
        },
        [
          { type: "classify_skipped", detail: { skipReason: outcome.reason } },
          { type: "run_done", detail: { status: "skipped" } },
        ]
      );
      return;
    }
    this.transition(
      (meta) => {
        meta.status = "done";
        meta.failedStage = null;
      },
      [{ type: "run_done", detail: { status: "done", ...outcome.detail } }]
    );
  }

  attemptStarted(): number {
    return this.transition((meta) => {
      meta.attempts += 1;
    }, []).attempts;
  }

  resetAttempts(): void {
    this.transition((meta) => {
      meta.attempts = 0;
    }, []);
  }

  reopen(fromStage: string): Readonly<RunMeta> {
    return this.transition(
      (meta) => {
        meta.status = "pending";
        meta.failedStage = null;
        meta.failureHint = null;
        meta.skipReason = null;
      },
      /* A retry used to leave no trace but a second `stage_started`, so a
         timeline read later could not tell a resumed Run from a slow one. */
      [{ type: "run_reopened", detail: { fromStage } }]
    );
  }

  appendEvent(type: RunEventType, detail?: Record<string, unknown>): void {
    appendEvent(this.dir, type, detail);
  }

  readResult(): ExtractionResult | null {
    return readResult(this.dir);
  }

  writeResult(result: ExtractionResult): void {
    writeFileSync(join(this.dir, "result.json"), JSON.stringify(result, null, 2) + "\n", "utf8");
  }

  deleteResult(): void {
    rmSync(join(this.dir, "result.json"), { force: true });
  }

  readContext(): RunContext {
    return readContext(this.dir);
  }

  readTranscript(): string {
    return readTranscript(this.dir);
  }

  writeTranscript(text: string): void {
    writeFileSync(join(this.dir, "transcript.txt"), text, "utf8");
  }
}

export function openRuns(workspaceDir: string): Runs {
  const layout = workspaceLayout(workspaceDir);

  return {
    create(input: NewRun): RunHandle {
      mkdirSync(layout.runsDir, { recursive: true });
      const id = newRunId();
      const dir = layout.runDir(id);
      mkdirSync(dir);
      const meta: RunMeta = {
        id,
        createdAt: new Date().toISOString(),
        source: input.source,
        fileName: input.fileName,
        sourceUrl: input.sourceUrl,
        externalId: input.externalId,
        status: "pending",
        attempts: 0,
        failedStage: null,
        skipReason: null,
        failureHint: null,
      };
      writeMeta(dir, meta);
      writeFileSync(
        join(dir, "context.json"),
        JSON.stringify(input.context, null, 2) + "\n",
        "utf8"
      );
      appendEvent(dir, "created", { source: input.source, fileName: input.fileName });
      return new RunHandleImpl(id, dir);
    },

    open(id: string): RunHandle | null {
      if (!isRunId(id)) {
        return null;
      }
      const dir = layout.runDir(id);
      if (!existsSync(dir)) {
        return null;
      }
      return new RunHandleImpl(id, dir);
    },

    list(): RunSummary[] {
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
    },

    detail(id: string): RunDetail | null {
      if (!isRunId(id)) {
        return null;
      }
      const dir = layout.runDir(id);
      if (!existsSync(dir)) {
        return null;
      }
      const meta = readMeta(dir);
      const result = readResult(dir);
      return {
        ...toSummary(meta, result),
        attempts: meta.attempts,
        failedStage: meta.failedStage,
        skipReason: meta.skipReason,
        failureHint: meta.failureHint,
        result,
        events: readEvents(dir),
        transcript: readTranscript(dir),
      };
    },
  };
}
