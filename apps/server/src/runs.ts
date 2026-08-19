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
} from "@transcript-tasks/shared";
import { isRunId, newRunId, workspaceLayout } from "./paths.js";

export interface RunAttendee {
  name: string;
  email: string | null;
}

export interface RunContext {
  meetingDate: string | null;
  attendees: RunAttendee[];
}

export interface RunHandle {
  readonly id: string;
  readonly dir: string;
  readMeta(): RunMeta;
  writeMeta(meta: RunMeta): void;
  appendEvent(type: RunEventType, detail?: Record<string, unknown>): void;
  readEvents(): RunEvent[];
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
    readonly dir: string
  ) {}

  readMeta(): RunMeta {
    return readMeta(this.dir);
  }

  writeMeta(meta: RunMeta): void {
    writeMeta(this.dir, meta);
  }

  appendEvent(type: RunEventType, detail?: Record<string, unknown>): void {
    appendEvent(this.dir, type, detail);
  }

  readEvents(): RunEvent[] {
    return readEvents(this.dir);
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
