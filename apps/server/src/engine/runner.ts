import type { RunMeta } from "@chief-of-staff-demo/shared";
import type { NewRun, RunHandle, Runs } from "../runs.js";
import { errorMessage } from "./failure.js";
import {
  OutsideStageError,
  StageFailure,
  type RunContext,
  type ShellModule,
} from "./module.js";

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

export interface RunnerDeps<Input> {
  /** Constructed once by the Shell: the run directory has one owner. */
  runs: Runs;
  module: ShellModule<Input>;
  log?: (message: string) => void;
}

const TERMINAL = new Set(["done", "skipped", "failed"]);

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

  private enqueue(run: RunHandle, input: Input): void {
    this.queue = this.queue.then(() => this.execute(run, input));
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
    }
  }

  /**
   * One Run's context. Every durable capability is refused while no Stage is
   * open, which is what stops a Run's status and its timeline disagreeing.
   */
  private context(run: RunHandle): RunContext {
    const mod = this.deps.module;
    let open: string | null = null;
    const inStage = (what: string): void => {
      if (open === null) {
        throw new OutsideStageError(what);
      }
    };
    return {
      runId: run.id,
      meta: () => run.read(),
      async stage<T>(name: string, fn: () => Promise<T>): Promise<T> {
        const outer = open;
        open = name;
        run.started(name);
        try {
          return await fn();
        } catch (error) {
          const failure = error instanceof StageFailure ? error : null;
          const reason = errorMessage(error);
          run.failed(
            name,
            reason,
            failure?.hint ?? mod.failureHint(name, reason),
            failure?.flags
          );
          throw error;
        } finally {
          open = outer;
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
      readFile: (name) => run.readArtifact(name),
      writeFile: (name, text) => {
        inStage(`write ${name}`);
        run.writeArtifact(name, text);
      },
    };
  }
}
