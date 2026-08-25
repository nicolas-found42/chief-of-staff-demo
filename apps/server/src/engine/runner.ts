import type { RunMeta } from "@chief-of-staff-demo/shared";
import type { NewRun, RunHandle, Runs } from "../runs.js";
import { errorMessage } from "./failure.js";
import { OutsideStageError, StageFailure, type RunContext, type ShellModule } from "./module.js";

/** What a Module's host knows about a new Run that the Shell does not. */
export type RunRecord = Omit<NewRun, "module" | "moduleVersion">;

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

export class RunNotResumableError extends Error {
  constructor(runId: string) {
    super(`Run is not resumable: ${runId}`);
    this.name = "RunNotResumableError";
  }
}

export interface RunnerDeps<Input> {
  /** Constructed once by the Shell: the run directory has one owner. */
  runs: Runs;
  module: ShellModule<Input>;
  /** Absent and `undefined` both mean: do not log. */
  log?: ((message: string) => void) | undefined;
  /** Clock used for durable wait records and recovery decisions. */
  now?: (() => Date) | undefined;
}

const TERMINAL = new Set(["done", "skipped", "failed"]);

/** Internal control flow: a durable wait is neither a failure nor an outcome. */
class RunBlocked extends Error {
  constructor() {
    super("Run blocked");
    this.name = "RunBlocked";
  }
}

/**
 * The generic Run engine: it creates Runs, hands a Module its context, records
 * every Stage, and carries out a retry the Module planned. It holds no
 * knowledge of any Module's Stages, Intakes, event names or result — one
 * Runner per Module, and adding a Module needs no change here (ADR-0003).
 *
 * Work is serialised through one promise chain, so two Runs never interleave a
 * model call or a batch of Google writes.
 */
export class Runner<Input> {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly active = new Set<string>();
  private recoveryTimer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: RunnerDeps<Input>) {}

  /** Resolves when every enqueued Run has settled (test seam). */
  async idle(): Promise<void> {
    await this.queue;
  }

  /** Create the Run and enqueue the Module's work. The id is available at once. */
  async startRun(record: RunRecord, input: Input): Promise<string> {
    const run = this.deps.runs.create({
      module: this.deps.module.id,
      moduleVersion: this.deps.module.version,
      ...record,
    });
    this.enqueue(run, input);
    return run.id;
  }

  /**
   * Re-run a failed Run in place, the way its Module says to. The plan is the
   * Module's; carrying it out — the reset, the discards, the reopen — is the
   * Shell's, because none of it happens inside a Stage.
   */
  async retryRun(id: string): Promise<RunMeta> {
    const run = this.deps.runs.open(id);
    if (!run) {
      throw new RunNotFoundError(id);
    }
    const plan = this.deps.module.planRetry(run.read());
    if (!plan) {
      throw new RunNotRetryableError(id);
    }
    if (plan.resetAttempts) {
      run.resetAttempts();
    }
    for (const name of plan.discard ?? []) {
      run.deleteArtifact(name);
    }
    const reopened = run.reopen(plan.fromStage);
    this.enqueue(run, plan.input);
    return reopened;
  }

  /** Continue a blocked Run in place using the owning Module's durable plan. */
  async resumeRun(id: string): Promise<RunMeta> {
    const run = this.deps.runs.open(id);
    if (!run) {
      throw new RunNotFoundError(id);
    }
    const meta = run.read();
    if (meta.status !== "blocked" || !meta.wait) {
      throw new RunNotResumableError(id);
    }
    const plan = this.deps.module.planResume?.(meta) ?? null;
    if (!plan) {
      throw new RunNotResumableError(id);
    }
    const resumed = run.resumed(plan.fromStage, "module");
    this.enqueue(run, plan.input);
    return resumed;
  }

  /**
   * Reconstruct work whose in-memory queue vanished. Future and indefinite
   * waits remain blocked; due clock waits and Module-planned pending/running
   * Runs are returned to the same queue in place.
   */
  async recoverRuns(): Promise<number> {
    let recovered = 0;
    const now = this.deps.now?.() ?? new Date();
    for (const summary of this.deps.runs.list({ module: this.deps.module.id }).runs) {
      if (this.active.has(summary.id)) {
        continue;
      }
      const run = this.deps.runs.open(summary.id);
      if (!run) {
        continue;
      }
      const meta = run.read();
      if (meta.status === "blocked" && meta.wait?.timeout.kind === "at") {
        if (Date.parse(meta.wait.timeout.at) > now.getTime()) {
          continue;
        }
        const plan = this.deps.module.planResume?.(meta) ?? null;
        if (plan) {
          run.resumed(plan.fromStage, "clock");
          if (this.enqueue(run, plan.input)) {
            recovered += 1;
          }
        }
        continue;
      }
      if (meta.status !== "pending" && meta.status !== "running") {
        continue;
      }
      const plan = this.deps.module.planRecovery?.(meta) ?? null;
      if (!plan) {
        continue;
      }
      run.recovered(plan.fromStage);
      if (this.enqueue(run, plan.input)) {
        recovered += 1;
      }
    }
    return recovered;
  }

  /** Keep clock waits live after boot; the durable record remains the source of truth. */
  startRecoveryLoop(intervalMs = 30_000): void {
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
    void this.recoverRuns();
    this.recoveryTimer = setInterval(() => void this.recoverRuns(), intervalMs);
    this.recoveryTimer.unref();
  }

  stopRecoveryLoop(): void {
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
    this.recoveryTimer = null;
  }

  private enqueue(run: RunHandle, input: Input): boolean {
    if (this.active.has(run.id)) {
      return false;
    }
    this.active.add(run.id);
    this.queue = this.queue.then(() => this.execute(run, input));
    return true;
  }

  private async execute(run: RunHandle, input: Input): Promise<void> {
    try {
      run.finished(await this.deps.module.run(this.context(run), input));
    } catch (error) {
      /* A Stage failure is already on the Run, so the log stays quiet about it.
         Anything else escaped a Stage — a Module bug, or durable work refused
         outside one — and leaves the Run where it stood, which is the restart
         hole's shape and is fixed with it. */
      if (!TERMINAL.has(run.read().status)) {
        this.deps.log?.(`Run ${run.id} stopped outside a Stage: ${errorMessage(error)}`);
      }
    } finally {
      this.active.delete(run.id);
    }
  }

  /**
   * One Run's context. Every durable capability is refused while no Stage is
   * open, which is what stops a Run's status and its timeline disagreeing.
   */
  private context(run: RunHandle): RunContext {
    const mod = this.deps.module;
    const stack: string[] = [];
    const inStage = (what: string): void => {
      if (stack.length === 0) {
        throw new OutsideStageError(what);
      }
    };
    return {
      runId: run.id,
      meta: () => run.read(),
      async stage<T>(name: string, fn: () => Promise<T>): Promise<T> {
        stack.push(name);
        run.started(name);
        try {
          return await fn();
        } catch (error) {
          if (error instanceof RunBlocked) {
            throw error;
          }
          const failure = error instanceof StageFailure ? error : null;
          const reason = errorMessage(error);
          run.failed(name, reason, failure?.hint ?? mod.failureHint(name, reason), failure?.flags);
          throw error;
        } finally {
          stack.pop();
        }
      },
      event: (type, detail) => {
        inStage(`event ${type}`);
        run.appendEvent(type, detail);
      },
      attempt: () => {
        inStage("attempt");
        return run.attemptStarted();
      },
      wait: ({ reason, timeout }) => {
        inStage("wait");
        const stage = stack.at(-1)!;
        run.blocked({
          requestedAt: (this.deps.now?.() ?? new Date()).toISOString(),
          stage,
          reason,
          timeout,
        });
        throw new RunBlocked();
      },
      readFile: (name) => run.readArtifact(name),
      writeFile: (name, text) => {
        inStage(`write ${name}`);
        run.writeArtifact(name, text);
      },
    };
  }
}
