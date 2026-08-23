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
    module: "transcript",
    moduleVersion: 1,
    intake: "drive",
    fileName: "meeting.md",
    sourceUrl: null,
    externalId: null,
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
    expect(meta.module).toBe("transcript");
    expect(meta.moduleVersion).toBe(1);
    expect(meta.intake).toBe("drive");
    expect(meta.fileName).toBe("meeting.md");
    expect(types()).toEqual(["created"]);
    expect(detailOf("created")).toEqual({ intake: "drive", fileName: "meeting.md" });
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

  it("records the connection as the cause only when told to, and additively", () => {
    /* A plain failure must look exactly like a legacy one: no marker field. */
    run.started("outputs");
    run.failed("outputs", "boom", "Output creation failed.");
    expect(run.read().connectionCaused).toBeUndefined();

    /* The connection-caused failure sets the flag and nothing else about the
       shape of meta changes (D6). */
    const other = runs.create({
      module: "transcript",
      moduleVersion: 1,
      intake: "drive",
      fileName: "other.md",
      sourceUrl: null,
      externalId: null,
    });
    other.failed("outputs", "google_expired", "Google sign-in expired.", {
      connectionCaused: true,
    });
    const meta = other.read();
    expect(meta.connectionCaused).toBe(true);
    expect(meta.status).toBe("failed");
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
      module: "transcript",
      moduleVersion: 1,
      intake: "watch",
      fileName: "second.md",
      sourceUrl: null,
      externalId: null,
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

describe("artifacts", () => {
  it("write/read/delete round-trip", () => {
    run.writeArtifact("result.json", JSON.stringify({ tasks: [{ title: "a" }] }));
    expect(run.readArtifact("result.json")).toBe(JSON.stringify({ tasks: [{ title: "a" }] }));
    run.deleteArtifact("result.json");
    expect(run.readArtifact("result.json")).toBeNull();
  });

  it("rejects bad names", () => {
    expect(() => run.writeArtifact("../evil", "x")).toThrow(/Invalid artifact name/);
    expect(() => run.readArtifact("bad/name")).toThrow(/Invalid artifact name/);
    expect(() => run.deleteArtifact("")).toThrow(/Invalid artifact name/);
  });

  it("refuses reserved names", () => {
    expect(() => run.writeArtifact("meta.json", "{}")).toThrow(/Invalid artifact name/);
    expect(() => run.writeArtifact("events.jsonl", "{}")).toThrow(/Invalid artifact name/);
    expect(() => run.readArtifact("meta.json")).toThrow(/Invalid artifact name/);
    expect(() => run.readArtifact("events.jsonl")).toThrow(/Invalid artifact name/);
  });
});

describe("optional fileName", () => {
  it("lists and details a Run with no fileName without throwing", () => {
    const noFile = runs.create({
      module: "transcript",
      moduleVersion: 1,
      intake: "drive",
      sourceUrl: null,
      externalId: null,
    });
    expect(noFile.read().fileName).toBeUndefined();
    expect(noFile.read().intake).toBe("drive");
    const listed = runs.list();
    expect(listed.find((r) => r.id === noFile.id)?.fileName).toBeUndefined();
    expect(listed.find((r) => r.id === noFile.id)?.intake).toBe("drive");
    const detail = runs.detail(noFile.id);
    expect(detail?.fileName).toBeUndefined();
    expect(detail?.intake).toBe("drive");
    const createdDetail = detail?.events.find((e) => e.type === "created")?.detail;
    expect(createdDetail).toEqual({ intake: "drive" });
  });
});

describe("module events", () => {
  it("round-trips a Module-named event the Shell has never heard of", () => {
    run.appendEvent("transcript_custom_event", { foo: "bar" });
    const found = runs.detail(run.id)!.events.find((e) => e.type === "transcript_custom_event");
    expect(found).toBeDefined();
    expect(found?.detail).toEqual({ foo: "bar" });
    expect(types()).toContain("transcript_custom_event");
  });
});
