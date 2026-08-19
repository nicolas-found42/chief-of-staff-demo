import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { beforeEach, describe, expect, it } from "vitest";
import type { CompleteJson } from "../../../apps/server/src/llm/providers";
import type { GoogleOutputs } from "../../../apps/server/src/google/outputs";
import { Pipeline, meetingDateFromFileName } from "../../../apps/server/src/pipeline/run";
import { openRuns } from "../../../apps/server/src/runs";
import { composeTaskNotes } from "../../../apps/server/src/google/tasks";

const GOLDEN = {
  version: 1 as const,
  sourceId: "",
  sourceFileName: "",
  sourceUrl: null,
  processedAt: "2026-08-18T00:00:00.000Z",
  isTranscript: true,
  skipReason: null,
  summary: "A weekly sync.",
  tasks: [
    {
      title: "Write up export approach",
      owner: "Priya",
      due: "2026-08-21",
      notes: "Background job write-up for planning.",
      sourceQuote: "I'll have it in the doc by Friday",
    },
    { title: "Update help docs" },
  ],
  drafts: [{ to: "", subject: "Updated Q3 pricing", body: "Hello,", reason: "Acme needs telling." }],
};

const NON_TRANSCRIPT = {
  ...GOLDEN,
  isTranscript: false,
  skipReason: "Document is a product spec, not a transcript",
  tasks: [],
  drafts: [],
};

interface FakeGoogle extends GoogleOutputs {
  calls: {
    tasklists: string[];
    tasks: { title: string; notes: string; due?: string }[];
    drafts: { to: string; subject: string }[];
  };
}

function fakeGoogle(): FakeGoogle {
  const google: FakeGoogle = {
    calls: { tasklists: [], tasks: [], drafts: [] },
    findOrCreateTasklist: async (title: string) => {
      google.calls.tasklists.push(title);
      return "list-1";
    },
    createTask: async (_tasklistId, item, source) => {
      const task = {
        title: item.title,
        notes: composeTaskNotes(item, source),
        ...(item.due ? { due: item.due } : {}),
      };
      google.calls.tasks.push(task);
      return `task-${google.calls.tasks.length}`;
    },
    createDraft: async (draft) => {
      google.calls.drafts.push({ to: draft.to ?? "", subject: draft.subject });
      return `draft-${google.calls.drafts.length}`;
    },
  };
  return google;
}

function throwingProvider(): CompleteJson {
  return async () => {
    throw new Error("boom");
  };
}

function scriptedProvider(script: unknown[]): { complete: CompleteJson; attempts: () => number } {
  let calls = 0;
  return {
    complete: async () => {
      const next = script[Math.min(calls, script.length - 1)];
      calls += 1;
      if (next === "THROW") {
        throw new Error("boom");
      }
      return next;
    },
    attempts: () => calls,
  };
}

describe("meetingDateFromFileName", () => {
  it("recovers the date from a Fireflies-style export name", () => {
    expect(
      meetingDateFromFileName("Copy of Abhinav- Richard-transcript-2026-06-18T13-00-00.000Z.json")
    ).toBe("2026-06-18");
  });

  it("returns null for names without an embedded timestamp", () => {
    expect(meetingDateFromFileName("Found42 Stand-Up Meeting_transcript.txt")).toBeNull();
    expect(meetingDateFromFileName("notes-2026-08-18.md")).toBeNull();
  });
});

describe("Pipeline", () => {
  let workspaceDir: string;
  let provider: { complete: CompleteJson; attempts: () => number };
  let google: FakeGoogle | null;
  let pipeline: Pipeline;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "pipeline-"));
    provider = scriptedProvider([GOLDEN]);
    google = fakeGoogle();
    pipeline = new Pipeline({
      workspaceDir,
      getCompleteJson: () => provider.complete,
      getLlmInfo: () => ({ provider: "mock", model: "test-model" }),
      getGoogle: () => google,
      getTasklistName: () => "Meeting Followups",
    });
  });

  const detailOf = (id: string) => openRuns(workspaceDir).detail(id);
  const summariesOf = () => openRuns(workspaceDir).list();

  it("golden transcript → done with task and draft events", async () => {
    const runId = await pipeline.startRun({
      type: "upload",
      fileName: "meeting.md",
      bytes: Buffer.from("**Dana:** hello\n"),
    });
    await pipeline.idle();
    const detail = detailOf(runId);
    expect(detail).not.toBeNull();
    expect(detail!.status).toBe("done");
    expect(detail!.attempts).toBe(1);
    expect(detail!.result?.tasks).toHaveLength(2);
    // Identity fields are server-authoritative, not LLM output.
    expect(detail!.result?.sourceId).toBe(runId);
    expect(detail!.result?.sourceFileName).toBe("meeting.md");
    expect(detail!.result?.processedAt).not.toBe("2026-08-18T00:00:00.000Z");
    const types = detail!.events.map((event) => event.type);
    expect(types).toContain("extract_attempt");
    expect(types).toContain("extract_ok");
    expect(types.filter((type) => type === "google_task_created")).toHaveLength(2);
    expect(types.filter((type) => type === "gmail_draft_created")).toHaveLength(1);
    expect(types[types.length - 1]).toBe("run_done");
    expect(types.filter((t) => t === "stage_started")).toHaveLength(3);
    expect(google!.calls.tasklists).toEqual(["Meeting Followups"]);
    expect(google!.calls.tasks[0]).toEqual({
      title: "Write up export approach",
      notes: [
        "Owner: Priya",
        "Background job write-up for planning.",
        'Quote: "I\'ll have it in the doc by Friday"',
        "Source: meeting.md",
      ].join("\n"),
      due: "2026-08-21",
    });
    expect(google!.calls.drafts[0].to).toBe("");
    const summaries = summariesOf();
    expect(summaries[0].taskCount).toBe(2);
  });

  it("sniffs the meeting date from a timestamped upload file name", async () => {
    const runId = await pipeline.startRun({
      type: "upload",
      fileName: "Copy of X-transcript-2026-06-18T13-00-00.000Z.json",
      text: "Richard: hi",
    });
    await pipeline.idle();
    const context = JSON.parse(
      readFileSync(join(workspaceDir, "runs", runId, "context.json"), "utf8")
    ) as { meetingDate: string | null };
    expect(context.meetingDate).toBe("2026-06-18");
  });

  it("uses externalId as sourceId and honors pre-converted text", async () => {
    const runId = await pipeline.startRun({
      type: "fireflies",
      fileName: "Weekly Sync",
      text: "Dana: hello\n",
      sourceUrl: "https://app.fireflies.ai/t/abc",
      externalId: "FF123",
    });
    await pipeline.idle();
    const detail = detailOf(runId);
    expect(detail!.status).toBe("done");
    expect(detail!.result?.sourceId).toBe("FF123");
    expect(detail!.result?.sourceUrl).toBe("https://app.fireflies.ai/t/abc");
    expect(detail!.transcript).toBe("Dana: hello\n");
    expect(detail!.source).toBe("fireflies");
  });

  it("non-transcript → skipped with persisted result and no google calls", async () => {
    provider = scriptedProvider([NON_TRANSCRIPT]);
    const runId = await pipeline.startRun({
      type: "upload",
      fileName: "spec.pdf",
      text: "A product specification.",
    });
    await pipeline.idle();
    const detail = detailOf(runId);
    expect(detail!.status).toBe("skipped");
    expect(detail!.skipReason).toContain("not a transcript");
    expect(detail!.result?.isTranscript).toBe(false);
    const types = detail!.events.map((event) => event.type);
    expect(types).toContain("classify_skipped");
    expect(types).toContain("run_done");
    expect(google!.calls.tasks).toHaveLength(0);
  });

  it("provider failure ×3 → failed at extract, each attempt error recorded", async () => {
    provider = { complete: throwingProvider(), attempts: () => 0 };
    const runId = await pipeline.startRun({
      type: "upload",
      fileName: "meeting.md",
      text: "hello",
    });
    await pipeline.idle();
    const detail = detailOf(runId);
    expect(detail!.status).toBe("failed");
    expect(detail!.failedStage).toBe("extract");
    expect(detail!.attempts).toBe(3);
    expect(detail!.events.filter((event) => event.type === "extract_attempt")).toHaveLength(3);
    const attemptErrors = detail!.events.filter((event) => event.type === "extract_error");
    expect(attemptErrors).toHaveLength(3);
    expect(attemptErrors[0]?.detail?.error).toBe("boom");
    const attempt = detail!.events.find((event) => event.type === "extract_attempt");
    expect(attempt?.detail).toMatchObject({ provider: "mock", model: "test-model" });
    expect(detail!.failureHint).toBe("Extraction failed after 3 attempts.");
    const types = detail!.events.map((event) => event.type);
    expect(types).toContain("stage_started");
  });

  it("schema-invalid output ×3 counts as failed attempts", async () => {
    provider = scriptedProvider([{ ...GOLDEN, version: 2 }]);
    const runId = await pipeline.startRun({
      type: "upload",
      fileName: "meeting.md",
      text: "hello",
    });
    await pipeline.idle();
    const detail = detailOf(runId);
    expect(detail!.status).toBe("failed");
    expect(detail!.failedStage).toBe("extract");
    expect(detail!.attempts).toBe(3);
    expect(provider.attempts()).toBe(3);
  });

  it("google disconnected → failed at outputs with google_not_connected; retry after connecting", async () => {
    google = null;
    const runId = await pipeline.startRun({
      type: "upload",
      fileName: "meeting.md",
      text: "hello",
    });
    await pipeline.idle();
    const failed = detailOf(runId);
    expect(failed!.status).toBe("failed");
    expect(failed!.failedStage).toBe("outputs");
    expect(failed!.events.map((event) => event.type)).toContain("google_not_connected");
    expect(failed!.failureHint).toBe("Output creation failed. Connect Google in Settings, then retry.");
    // Result was persisted before the outputs stage.
    expect(failed!.result?.isTranscript).toBe(true);

    google = fakeGoogle();
    await pipeline.retryRun(runId);
    await pipeline.idle();
    const retried = detailOf(runId);
    expect(retried!.status).toBe("done");
    expect(retried!.attempts).toBe(1);
    expect(google!.calls.tasks).toHaveLength(2);
  });

  it("retry of an extract-failed run re-runs extraction from scratch", async () => {
    provider = scriptedProvider([{ ...GOLDEN, version: 2 }]);
    const runId = await pipeline.startRun({
      type: "upload",
      fileName: "meeting.md",
      text: "hello",
    });
    await pipeline.idle();
    expect(detailOf(runId)!.status).toBe("failed");

    provider = scriptedProvider([GOLDEN]);
    await pipeline.retryRun(runId);
    await pipeline.idle();
    const retried = detailOf(runId);
    expect(retried!.status).toBe("done");
    expect(retried!.attempts).toBe(1);
  });

  it("rejects retry of a run that is not failed", async () => {
    const runId = await pipeline.startRun({
      type: "upload",
      fileName: "meeting.md",
      text: "hello",
    });
    await pipeline.idle();
    await expect(pipeline.retryRun(runId)).rejects.toThrow(/not retryable/);
  });

  it("conversion failure produces a visible failed run", async () => {
    const runId = await pipeline.startRun({
      type: "upload",
      fileName: "garbage.json",
      bytes: Buffer.from('{"not":"sentences"}'),
    });
    await pipeline.idle();
    const detail = detailOf(runId);
    expect(detail!.status).toBe("failed");
    expect(detail!.failedStage).toBe("convert");
    expect(detail!.events[detail!.events.length - 1].type).toBe("run_failed");
    expect(detail!.failureHint).toBe("This file could not be converted to text.");
    expect(detail!.events.map((e) => e.type)).toContain("stage_failed");
    await expect(pipeline.retryRun(runId)).rejects.toThrow(/not retryable/);
  });

  it("one bad task does not kill the batch (drainOutbox parity)", async () => {
    const googleRef = google!;
    const flaky: FakeGoogle = {
      ...googleRef,
      calls: googleRef.calls,
      createTask: async (tasklistId, item, source) => {
        if (item.title === "Update help docs") {
          throw new Error("quota exceeded");
        }
        return googleRef.createTask(tasklistId, item, source);
      },
    };
    google = flaky;
    const runId = await pipeline.startRun({
      type: "upload",
      fileName: "meeting.md",
      text: "hello",
    });
    await pipeline.idle();
    const detail = detailOf(runId);
    expect(detail!.status).toBe("done");
    const types = detail!.events.map((event) => event.type);
    expect(types).toContain("google_task_error");
    expect(types.filter((type) => type === "google_task_created")).toHaveLength(1);
    expect(types).toContain("gmail_draft_created");
  });

  it("writes transcript text and context to the run directory", async () => {
    const runId = await pipeline.startRun({
      type: "upload",
      fileName: "meeting.md",
      text: "line\r\nline",
    });
    await pipeline.idle();
    const transcript = await readFile(join(workspaceDir, "runs", runId, "transcript.txt"), "utf8");
    expect(transcript).toBe("line\r\nline");
  });
});
