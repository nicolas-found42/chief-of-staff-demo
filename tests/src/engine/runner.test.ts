import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { RunMeta } from "@chief-of-staff-demo/shared";
import {
  StageFailure,
  type RetryPlan,
  type RunContext,
  type ShellModule,
} from "../../../apps/server/src/engine/module";
import { Runner, RunNotFoundError, RunNotRetryableError } from "../../../apps/server/src/engine/runner";
import { openRuns, type Runs } from "../../../apps/server/src/runs";

/**
 * The Module context is this spec's principal seam: a Module is tested by
 * driving its `run` with a context over a temporary Workspace, which is what
 * ADR-0003 said a Module would be, and now is. Nothing here goes through HTTP,
 * Google, or a model.
 */
interface FakeInput {
  /** What the Module does inside its one Stage. */
  work?: (ctx: RunContext) => Promise<void>;
  /** What it tries before opening a Stage at all. */
  before?: (ctx: RunContext) => void;
}

let workspaceDir: string;
let runs: Runs;
/** What the fake Module refused to do outside a Stage, as it saw it. */
let refusal: string | null;

function fakeModule(overrides: Partial<ShellModule<FakeInput>> = {}): ShellModule<FakeInput> {
  return {
    id: "fake",
    version: 2,
    failureHint: (stage) => `${stage} did not work.`,
    planRetry: () => null,
    async run(ctx, input) {
      if (input.before) {
        try {
          input.before(ctx);
        } catch (error) {
          refusal = error instanceof Error ? error.name : String(error);
        }
      }
      return await ctx.stage("only", async () => {
        await input.work?.(ctx);
        return { status: "done" };
      });
    },
    ...overrides,
  };
}

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "cos-runner-"));
  runs = openRuns(workspaceDir);
  refusal = null;
});

const record = { intake: "manual", sourceUrl: null, externalId: null };

describe("driving a Module with a context", () => {
  it("stamps the Module's identity on the Run and records the Stage it opened", async () => {
    const runner = new Runner({ runs, module: fakeModule() });
    const id = await runner.startRun(record, {
      work: async (ctx) => {
        ctx.writeFile("counted.json", JSON.stringify({ seen: 3 }));
        ctx.event("counted", { seen: 3 });
      },
    });
    await runner.idle();

    const detail = runs.detail(id)!;
    expect(detail.status).toBe("done");
    expect(runs.open(id)!.read().module).toBe("fake");
    expect(runs.open(id)!.read().moduleVersion).toBe(2);
    expect(detail.events.map((event) => event.type)).toEqual([
      "created",
      "stage_started",
      "counted",
      "run_done",
    ]);
    expect(runs.open(id)!.readArtifact("counted.json")).toBe('{"seen":3}');
  });

  it("carries the Module's own outcome, including a Run that ends without doing the work", async () => {
    const runner = new Runner({
      runs,
      module: fakeModule({
        async run(ctx) {
          return await ctx.stage("only", async () => ({
            status: "skipped",
            reason: "nothing to do",
          }));
        },
      }),
    });
    const id = await runner.startRun(record, {});
    await runner.idle();

    expect(runs.detail(id)!.status).toBe("skipped");
    expect(runs.detail(id)!.skipReason).toBe("nothing to do");
  });
});

describe("a Module cannot do durable work outside a Stage", () => {
  it("refuses a file, an event and an attempt, and records none of them", async () => {
    const runner = new Runner({ runs, module: fakeModule() });
    const id = await runner.startRun(record, {
      before: (ctx) => ctx.writeFile("early.json", "{}"),
    });
    await runner.idle();

    expect(refusal).toBe("OutsideStageError");
    expect(existsSync(join(workspaceDir, "runs", id, "early.json"))).toBe(false);
    /* The Run still finished: the refusal is the Shell declining to record
       something, not a failure of the Module's work. */
    expect(runs.detail(id)!.status).toBe("done");

    const events = new Runner({ runs, module: fakeModule() });
    const second = await events.startRun(record, { before: (ctx) => ctx.event("early") });
    await events.idle();
    expect(refusal).toBe("OutsideStageError");
    expect(runs.detail(second)!.events.map((e) => e.type)).not.toContain("early");

    const attempts = new Runner({ runs, module: fakeModule() });
    const third = await attempts.startRun(record, { before: (ctx) => void ctx.attempt() });
    await attempts.idle();
    expect(refusal).toBe("OutsideStageError");
    expect(runs.detail(third)!.attempts).toBe(0);
  });

  it("leaves a Run alone when the refusal escapes the Module, rather than claiming it ended", async () => {
    const logged: string[] = [];
    const runner = new Runner({
      runs,
      module: fakeModule({
        async run(ctx) {
          ctx.writeFile("early.json", "{}");
          return { status: "done" };
        },
      }),
      log: (message) => logged.push(message),
    });
    const id = await runner.startRun(record, {});
    await runner.idle();

    expect(runs.detail(id)!.status).toBe("pending");
    expect(logged.join("\n")).toContain("outside a Stage");
  });
});

describe("a failure inside a Stage", () => {
  it("records the Stage and the Module's default hint", async () => {
    const runner = new Runner({ runs, module: fakeModule() });
    const id = await runner.startRun(record, {
      work: async () => {
        throw new Error("the model said no");
      },
    });
    await runner.idle();

    const detail = runs.detail(id)!;
    expect(detail.status).toBe("failed");
    expect(detail.failedStage).toBe("only");
    expect(detail.failureHint).toBe("only did not work.");
    expect(detail.events.map((event) => event.type)).toEqual([
      "created",
      "stage_started",
      "stage_failed",
      "run_failed",
    ]);
    expect(detail.events.find((e) => e.type === "run_failed")?.detail).toEqual({
      stage: "only",
      reason: "the model said no",
    });
  });

  it("prefers the wording the Module supplied, and its verdict on the connection", async () => {
    const runner = new Runner({ runs, module: fakeModule() });
    const id = await runner.startRun(record, {
      work: async () => {
        throw new StageFailure("google_expired", "Sign in again.", { connectionCaused: true });
      },
    });
    await runner.idle();

    const detail = runs.detail(id)!;
    expect(detail.failureHint).toBe("Sign in again.");
    expect(detail.connectionCaused).toBe(true);
  });
});

describe("retry", () => {
  const failing = (): ShellModule<FakeInput> =>
    fakeModule({
      planRetry(meta: Readonly<RunMeta>): RetryPlan<FakeInput> | null {
        return meta.status === "failed"
          ? { fromStage: "only", input: {}, resetAttempts: true, discard: ["scratch.json"] }
          : null;
      },
    });

  it("carries out the plan the Module wrote, in place", async () => {
    const runner = new Runner({ runs, module: failing() });
    const id = await runner.startRun(record, {
      work: async (ctx) => {
        ctx.attempt();
        ctx.writeFile("scratch.json", "{}");
        throw new Error("boom");
      },
    });
    await runner.idle();
    expect(runs.detail(id)!.attempts).toBe(1);

    const reopened = await runner.retryRun(id);
    expect(reopened.status).toBe("pending");
    expect(reopened.failureHint).toBeNull();
    await runner.idle();

    const detail = runs.detail(id)!;
    expect(detail.status).toBe("done");
    expect(detail.attempts).toBe(0);
    expect(runs.open(id)!.readArtifact("scratch.json")).toBeNull();
    expect(detail.events.map((e) => e.type)).toContain("run_reopened");
    /* Retried in place: one Run, not two. */
    expect(runs.list()).toHaveLength(1);
  });

  it("refuses a Run its Module will not re-run, and one that is not there", async () => {
    const runner = new Runner({ runs, module: failing() });
    const id = await runner.startRun(record, {});
    await runner.idle();

    await expect(runner.retryRun(id)).rejects.toThrow(RunNotRetryableError);
    await expect(runner.retryRun("run_20260101-000000_deadbeef")).rejects.toThrow(RunNotFoundError);
  });
});
