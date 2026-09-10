import { notifyWorkspaceChange } from "./engine/workspace-changes.js";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import {
  WorkspaceIntegrityError,
  readJsonRecord,
  writeFileVerifiedSync,
  writeJsonVerifiedSync,
} from "./engine/commit.js";
import { join } from "node:path";
import {
  type RunDetail,
  type RunEvent,
  type RunFailureFlags,
  type RunMeta,
  type RunPage,
  type RunSummary,
  type RunWait,
  type ShellEventType,
} from "@chief-of-staff-demo/shared";
import { isRunId, newRunId, workspaceLayout } from "./paths.js";

/** How a Run ends. Both are terminal; `failed` has its own transition. */
export type RunOutcome =
  | {
      status: "done";
      /** One line about what the Module did, for the Runs list. Stored as
       *  written and interpreted nowhere. */
      summary?: string;
      detail?: Record<string, unknown>;
    }
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
  failed(stage: string, reason: string, hint: string, flags?: RunFailureFlags): void;
  /** Stop inside a Stage with a Shell-owned durable wait standing against the Run. */
  blocked(wait: RunWait): void;
  /** Clear a durable wait and return the Run to pending for enqueued work. */
  resumed(fromStage: string, requestedBy: "module" | "clock", reason: string): Readonly<RunMeta>;
  /** Re-enqueue process-orphaned work using the owning Module's recovery plan. */
  recovered(fromStage: string, reason: string): Readonly<RunMeta>;
  /** End the Run. */
  finished(outcome: RunOutcome): void;
  /** Count one attempt at the current Stage; returns the new count. */
  attemptStarted(): number;
  /** Start counting attempts again, for a Stage the Module is re-running from scratch. */
  resetAttempts(): void;
  /** Back to pending with the failure cleared, ready to run again from `fromStage`. */
  reopen(fromStage: string, reason: string): Readonly<RunMeta>;
  /** Module-named events. The Shell writes the Stage and status ones itself. */
  appendEvent(type: string, detail?: Record<string, unknown>): void;
  /** Module-owned per-Run files. The Shell stores, serves and deletes them and
   *  never reads inside one. */
  readArtifact(name: string): string | null;
  writeArtifact(name: string, text: string): void;
  deleteArtifact(name: string): void;
}

export interface NewRun {
  module: string;
  moduleVersion: number;
  intake: string;
  fileName?: string;
  sourceUrl: string | null;
  externalId: string | null;
}
/** Which Runs to list, and how many. */
interface RunQuery {
  /** Only this Module's Runs. Absent lists every Module's. */
  module?: string;
  /** Page size. Absent lists every Run. */
  limit?: number;
  /** Continue below this Run id. */
  cursor?: string | null;
}

export interface Runs {
  create(input: NewRun): RunHandle;
  open(id: string): RunHandle | null;
  list(query?: RunQuery): RunPage;
  detail(id: string): RunDetail | null;
}

/** A Run record that exists but cannot be read as the thing it claims to be. */
export class RunStoreCorruptionError extends WorkspaceIntegrityError {
  constructor(path: string, detail: string) {
    super(`Run record ${path} ${detail}`);
    this.name = "RunStoreCorruptionError";
  }
}

/**
 * Written through the Shell's commit protocol (#354): a unique sibling, a
 * rename over the target and a read-back of the published bytes. A torn
 * `meta.json` is the one failure that makes a Run vanish from the list rather
 * than merely look stale.
 */
function writeMeta(runDir: string, meta: RunMeta): void {
  writeJsonVerifiedSync(join(runDir, "meta.json"), meta);
}

function readMeta(runDir: string): RunMeta {
  const path = join(runDir, "meta.json");
  let meta: RunMeta | null;
  try {
    meta = readJsonRecord(path, isRunMeta);
  } catch (error) {
    throw new RunStoreCorruptionError(
      path,
      error instanceof Error ? error.message : "cannot be read",
    );
  }
  if (meta === null) throw new RunStoreCorruptionError(path, "is missing");
  return meta;
}

/**
 * The fields every reader of a Run depends on. A record carrying an unknown
 * status is refused rather than rendered: the alternative is a page that shows
 * a Run as neither pending nor finished, which reads as a product bug instead
 * of the damaged file it is.
 */
function isRunMeta(value: unknown): value is RunMeta {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.module === "string" &&
    typeof candidate.createdAt === "string" &&
    typeof candidate.attempts === "number" &&
    typeof candidate.status === "string" &&
    candidate.status in RUN_STATUSES
  );
}

/** Keyed by the status union, so a status added to `RunMeta` fails the build here. */
const RUN_STATUSES: Record<RunMeta["status"], true> = {
  pending: true,
  running: true,
  blocked: true,
  failed: true,
  done: true,
  skipped: true,
};

function appendEvent(runDir: string, type: string, detail?: Record<string, unknown>): void {
  const event: RunEvent = { at: new Date().toISOString(), type };
  if (detail) {
    event.detail = detail;
  }
  appendFileSync(join(runDir, "events.jsonl"), JSON.stringify(event) + "\n", "utf8");
}

/**
 * The timeline, with the one damaged line a crash can explain tolerated: an
 * interrupted append leaves the final line torn, and the transition's meta was
 * committed before it, so the state stays consistent without it. A damaged line
 * anywhere else means the timeline lost an event it once held — corruption, not
 * a race, and refusing it keeps a hole in the log from rendering as a complete
 * story (ADR-0086).
 */
function readEvents(runDir: string): RunEvent[] {
  const path = join(runDir, "events.jsonl");
  if (!existsSync(path)) {
    return [];
  }
  const lines = readFileSync(path, "utf8").split("\n");
  const events: RunEvent[] = [];
  for (const [index, line] of lines.entries()) {
    if (line.trim() === "") {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isRunEvent(parsed)) throw new Error("not an event");
      events.push(parsed);
    } catch {
      if (index === lines.length - 1) continue;
      throw new RunStoreCorruptionError(path, `is damaged at line ${index + 1}`);
    }
  }
  return events;
}

function isRunEvent(value: unknown): value is RunEvent {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.at === "string" && typeof candidate.type === "string";
}

function validateArtifactName(name: string): void {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) ||
    name === "meta.json" ||
    name === "events.jsonl"
  ) {
    throw new Error(`Invalid artifact name: ${name}`);
  }
}

/**
 * One row of the Runs list, from `meta.json` alone. Nothing here opens a
 * Module's result: the summary line was written by the Module when the Run
 * ended, so the list costs one small file per Run and the Shell reads inside
 * none of them.
 */
function toSummary(meta: RunMeta): RunSummary {
  return {
    id: meta.id,
    createdAt: meta.createdAt,
    module: meta.module,
    intake: meta.intake,
    ...(meta.fileName !== undefined ? { fileName: meta.fileName } : {}),
    sourceUrl: meta.sourceUrl,
    status: meta.status,
    wait: meta.wait ?? null,
    skipReason: meta.skipReason,
    summary: meta.summary ?? null,
    ...(meta.connectionState ? { connectionState: meta.connectionState } : {}),
  };
}

/** The Run's own files, so the Shell can link them without reading one. */
function artifactNames(runDir: string): string[] {
  try {
    return readdirSync(runDir)
      .filter((name) => name !== "meta.json" && name !== "events.jsonl" && !name.endsWith(".tmp"))
      .sort();
  } catch {
    return [];
  }
}

class RunHandleImpl implements RunHandle {
  constructor(
    readonly id: string,
    private readonly dir: string,
  ) {}

  read(): Readonly<RunMeta> {
    return readMeta(this.dir);
  }

  /** Every transition goes through here, so status and timeline cannot drift apart. */
  private transition(
    change: (meta: RunMeta) => void,
    events: { type: ShellEventType; detail?: Record<string, unknown> }[],
  ): RunMeta {
    const meta = readMeta(this.dir);
    change(meta);
    writeMeta(this.dir, meta);
    for (const event of events) {
      appendEvent(this.dir, event.type, event.detail);
    }
    notifyWorkspaceChange(join(this.dir, "../.."));
    return meta;
  }

  started(stage: string): void {
    this.transition(
      (meta) => {
        meta.status = "running";
      },
      [{ type: "stage_started", detail: { stage } }],
    );
  }

  failed(stage: string, reason: string, hint: string, flags?: RunFailureFlags): void {
    const eventDetail = flags?.eventDetail ?? {};
    this.transition(
      (meta) => {
        meta.status = "failed";
        meta.wait = null;
        meta.failedStage = stage;
        meta.failureHint = hint;
        if (flags?.connectionState) {
          meta.connectionState = flags.connectionState;
        } else {
          delete meta.connectionState;
        }
      },
      [
        {
          type: "stage_failed",
          detail: { ...eventDetail, stage, error: reason },
        },
        {
          type: "run_failed",
          detail: { ...eventDetail, stage, reason },
        },
      ],
    );
  }

  blocked(wait: RunWait): void {
    this.transition(
      (meta) => {
        meta.status = "blocked";
        meta.wait = wait;
      },
      [
        {
          type: "run_blocked",
          detail: { stage: wait.stage, reason: wait.reason, timeout: wait.timeout },
        },
      ],
    );
  }

  resumed(fromStage: string, requestedBy: "module" | "clock", reason: string): Readonly<RunMeta> {
    return this.transition(
      (meta) => {
        meta.status = "pending";
        meta.wait = null;
        meta.failedStage = null;
        meta.failureHint = null;
      },
      [{ type: "run_resumed", detail: { fromStage, requestedBy, reason } }],
    );
  }

  recovered(fromStage: string, reason: string): Readonly<RunMeta> {
    const previousStatus = this.read().status;
    return this.transition(
      (meta) => {
        meta.status = "pending";
        meta.wait = null;
        meta.failedStage = null;
        meta.failureHint = null;
      },
      [{ type: "run_recovered", detail: { fromStage, previousStatus, reason } }],
    );
  }

  finished(outcome: RunOutcome): void {
    if (outcome.status === "skipped") {
      this.transition(
        (meta) => {
          meta.status = "skipped";
          meta.wait = null;
          meta.skipReason = outcome.reason;
        },
        [
          { type: "classify_skipped", detail: { skipReason: outcome.reason } },
          { type: "run_done", detail: { status: "skipped" } },
        ],
      );
      return;
    }
    this.transition(
      (meta) => {
        meta.status = "done";
        meta.wait = null;
        meta.failedStage = null;
        /* The Module's line, recorded when the Run ended rather than derived
           later — so it survives the Module being renamed or removed, and
           cannot change after the fact. */
        meta.summary = outcome.summary ?? null;
      },
      [{ type: "run_done", detail: { status: "done", ...outcome.detail } }],
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

  reopen(fromStage: string, reason: string): Readonly<RunMeta> {
    return this.transition(
      (meta) => {
        meta.status = "pending";
        meta.wait = null;
        meta.failedStage = null;
        meta.failureHint = null;
        meta.skipReason = null;
        delete meta.connectionState;
      },
      /* A retry used to leave no trace but a second `stage_started`, so a
         timeline read later could not tell a resumed Run from a slow one. */
      [{ type: "run_reopened", detail: { fromStage, reason } }],
    );
  }

  appendEvent(type: string, detail?: Record<string, unknown>): void {
    appendEvent(this.dir, type, detail);
  }

  readArtifact(name: string): string | null {
    validateArtifactName(name);
    const path = join(this.dir, name);
    if (!existsSync(path)) {
      return null;
    }
    return readFileSync(path, "utf8");
  }

  writeArtifact(name: string, text: string): void {
    validateArtifactName(name);
    writeFileVerifiedSync(join(this.dir, name), text);
    notifyWorkspaceChange(join(this.dir, "../.."));
  }

  deleteArtifact(name: string): void {
    validateArtifactName(name);
    rmSync(join(this.dir, name), { force: true });
    notifyWorkspaceChange(join(this.dir, "../.."));
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
        module: input.module,
        moduleVersion: input.moduleVersion,
        intake: input.intake,
        ...(input.fileName !== undefined ? { fileName: input.fileName } : {}),
        sourceUrl: input.sourceUrl,
        externalId: input.externalId,
        status: "pending",
        wait: null,
        attempts: 0,
        failedStage: null,
        skipReason: null,
        failureHint: null,
        summary: null,
      };
      writeMeta(dir, meta);
      appendEvent(dir, "created", {
        intake: input.intake,
        ...(input.fileName !== undefined ? { fileName: input.fileName } : {}),
      });
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

    /**
     * Newest first, one page at a time. A run id carries its own UTC timestamp
     * to the second, so the directory names sort chronologically without
     * reading anything — which is what lets a page of 25 read 25 files rather
     * than every Run on disk.
     */
    list(query: RunQuery = {}): RunPage {
      let entries: string[];
      try {
        entries = readdirSync(layout.runsDir);
      } catch {
        return { runs: [], nextCursor: null };
      }
      const cursor = query.cursor ?? null;
      const ordered = entries
        .filter((entry) => isRunId(entry) && (cursor === null || entry < cursor))
        .sort()
        .reverse();
      const limit = query.limit ?? Infinity;
      const runs: RunSummary[] = [];
      let examined = 0;
      for (const entry of ordered) {
        if (runs.length >= limit) {
          break;
        }
        examined += 1;
        let meta: RunMeta;
        try {
          meta = readMeta(layout.runDir(entry));
        } catch {
          // Incomplete run dir (e.g. crashed mid-write); skip it.
          continue;
        }
        if (query.module !== undefined && meta.module !== query.module) {
          continue;
        }
        runs.push(toSummary(meta));
      }
      /* A cursor only when this page filled and something is left below it.
         With a Module filter what is left may all belong to another Module, so
         the next page can come back empty — a page too many, never a Run
         missed. */
      const more = runs.length >= limit && examined < ordered.length;
      return { runs, nextCursor: more ? (runs[runs.length - 1]?.id ?? null) : null };
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
      let result: unknown = null;
      const resultPath = join(dir, "result.json");
      if (existsSync(resultPath)) {
        try {
          result = JSON.parse(readFileSync(resultPath, "utf8"));
        } catch {
          result = null;
        }
      }
      return {
        ...toSummary(meta),
        attempts: meta.attempts,
        files: artifactNames(dir),
        failedStage: meta.failedStage,
        skipReason: meta.skipReason,
        failureHint: meta.failureHint,
        result,
        events: readEvents(dir),
      };
    },
  };
}
