import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { RunEvent } from "@chief-of-staff-demo/shared";
import { openRuns, type RunHandle, type Runs } from "../../../apps/server/src/runs";

let workspaceDir: string;
let runs: Runs;
let run: RunHandle;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "cos-runs-"));
  runs = openRuns(workspaceDir);
  run = runs.create({
    source: "upload",
    fileName: "meeting.md",
    sourceUrl: null,
    externalId: null,
    context: { meetingDate: "2026-08-18", attendees: [] },
  });
});

const events = (): RunEvent[] => runs.detail(run.id)!.events;
const types = (): string[] => events().map((event) => event.type);
const detailOf = (type: string) => events().find((event) => event.type === type)?.detail;

describe("create", () => {
  it("starts pending, with the source recorded in meta and in the timeline", () => {
    const meta = run.read();
    expect(meta.status).toBe("pending");
    expect(meta.attempts).toBe(0);
    expect(meta.failedStage).toBeNull();
    expect(types()).toEqual(["created"]);
  });
});

describe("transitions", () => {
  it("started moves the Run to running and logs the Stage in one step", () => {
    run.started("extract");
    expect(run.read().status).toBe("running");
    expect(detailOf("stage_started")).toEqual({ stage: "extract" });
  });

  it("failed records the Stage, the hint and both events together", () => {
    run.started("outputs");
    run.failed("outputs", "google_expired", "Google sign-in expired.");

    const meta = run.read();
    expect(meta.status).toBe("failed");
    expect(meta.failedStage).toBe("outputs");
    expect(meta.failureHint).toBe("Google sign-in expired.");
    expect(types()).toContain("stage_failed");
    expect(types()).toContain("run_failed");
    expect(detailOf("run_failed")).toEqual({ stage: "outputs", reason: "google_expired" });
  });

  it("finished(done) clears the failed Stage and carries the Module's own counts", () => {
    run.started("outputs");
    run.finished({ status: "done", detail: { tasks: 2, drafts: 1 } });

    expect(run.read().status).toBe("done");
    expect(run.read().failedStage).toBeNull();
    expect(detailOf("run_done")).toEqual({ status: "done", tasks: 2, drafts: 1 });
  });

  it("finished(skipped) records why, in meta and in the timeline", () => {
    run.finished({ status: "skipped", reason: "Document is a product spec, not a transcript" });

    const meta = run.read();
    expect(meta.status).toBe("skipped");
    expect(meta.skipReason).toBe("Document is a product spec, not a transcript");
    expect(detailOf("classify_skipped")).toEqual({
      skipReason: "Document is a product spec, not a transcript",
    });
    expect(detailOf("run_done")).toEqual({ status: "skipped" });
  });

  it("counts attempts, and starts again when a Module re-runs a Stage from scratch", () => {
    expect(run.attemptStarted()).toBe(1);
    expect(run.attemptStarted()).toBe(2);
    expect(run.read().attempts).toBe(2);

    run.resetAttempts();
    expect(run.read().attempts).toBe(0);
    expect(run.attemptStarted()).toBe(1);
  });

  it("reopen clears every trace of the failure and says so in the timeline", () => {
    run.started("outputs");
    run.failed("outputs", "boom", "Output creation failed.");
    run.finished({ status: "skipped", reason: "stale" });

    const reopened = run.reopen("outputs");

    expect(reopened.status).toBe("pending");
    expect(reopened.failedStage).toBeNull();
    expect(reopened.failureHint).toBeNull();
    expect(reopened.skipReason).toBeNull();
    // A retry used to leave no trace: a timeline read later could not tell a
    // resumed Run from a slow one.
    expect(detailOf("run_reopened")).toEqual({ fromStage: "outputs" });
  });
});

describe("the invariant the interface exists to hold", () => {
  it("never moves the status without the timeline saying so", () => {
    // Every transition, in the order a failing-then-retried Run makes them.
    run.started("extract");
    run.attemptStarted();
    run.failed("extract", "boom", "Extraction failed.");
    run.reopen("extract");
    run.started("extract");
    run.finished({ status: "done" });

    const statusEvents = types().filter((type) => type !== "created");
    expect(statusEvents).toEqual([
      "stage_started",
      "stage_failed",
      "run_failed",
      "run_reopened",
      "stage_started",
      "run_done",
    ]);
    // The status a caller reads and the last thing the log says agree.
    expect(run.read().status).toBe("done");
  });

  it("re-reads meta on every transition, so a stale caller cannot overwrite it", () => {
    // Two handles on one Run is the shape that used to lose writes: a caller
    // held a RunMeta across awaits and wrote its whole copy back.
    const other = runs.open(run.id)!;
    run.started("extract");
    other.attemptStarted();

    const meta = run.read();
    expect(meta.status).toBe("running");
    expect(meta.attempts).toBe(1);
  });
});

describe("durability", () => {
  it("leaves no partial meta.json behind", () => {
    run.started("extract");
    run.finished({ status: "done" });
    // The write goes through a temp file and a rename, so the directory never
    // holds a half-written meta for `list()` to trip over.
    const parsed = JSON.parse(readFileSync(join(workspaceDir, "runs", run.id, "meta.json"), "utf8"));
    expect(parsed.status).toBe("done");
    expect(runs.list()).toHaveLength(1);
  });

  it("keeps listing the other Runs when one directory is unreadable", () => {
    const other = runs.create({
      source: "watch",
      fileName: "second.md",
      sourceUrl: null,
      externalId: null,
      context: { meetingDate: null, attendees: [] },
    });
    writeFileSync(join(workspaceDir, "runs", other.id, "meta.json"), "{ torn", "utf8");

    const listed = runs.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]!.id).toBe(run.id);
  });

  it("tolerates a torn final line in the event log", () => {
    run.started("extract");
    const path = join(workspaceDir, "runs", run.id, "events.jsonl");
    writeFileSync(path, readFileSync(path, "utf8") + '{"at":"2026-08-19T00:00', "utf8");

    expect(types()).toEqual(["created", "stage_started"]);
  });
});

describe("open", () => {
  it("refuses anything that is not a run id, and anything that is not there", () => {
    expect(runs.open("../etc")).toBeNull();
    expect(runs.open("run_20260819-000000_deadbeef")).toBeNull();
    expect(runs.open(run.id)).not.toBeNull();
  });
});
