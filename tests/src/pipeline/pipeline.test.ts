import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { beforeEach, describe, expect, it } from "vitest";
import type { CompleteJson } from "../../../apps/server/src/llm/providers";
import type { GoogleOutputs } from "../../../apps/server/src/google/outputs";
import {
  ExtractionResultSchema,
  type ExtractionResult,
  type GoogleConnectionState,
} from "@chief-of-staff-demo/shared";
import { googleFailureHint, isRejectedGrant } from "../../../apps/server/src/google/connection";
import type { GoogleAccess } from "../../../apps/server/src/pipeline/run";
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
  drafts: [
    { to: "", subject: "Updated Q3 pricing", body: "Hello,", reason: "Acme needs telling." },
  ],
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
      return {
        googleId: `task-${google.calls.tasks.length}`,
        webViewLink: `https://tasks.google.com/task/task-${google.calls.tasks.length}`,
      };
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
      meetingDateFromFileName("Copy of Abhinav- Richard-transcript-2026-06-18T13-00-00.000Z.json"),
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
  /** The state `outputs()` refuses with while `google` is null. */
  let refusal: GoogleConnectionState;
  let pipeline: Pipeline;

  /* The Google connection as a Run sees it: a surface when one is available,
     and a verdict on whatever a Google call threw. `observe` is the real
     classifier, so a test cannot decide `expired` into existence. */
  const googleAccess = (): GoogleAccess => ({
    outputs: () => (google ? { ok: true, outputs: google } : { ok: false, state: refusal }),
    observe: (error: unknown) => (isRejectedGrant(error) ? "expired" : null),
  });

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "pipeline-"));
    provider = scriptedProvider([GOLDEN]);
    google = fakeGoogle();
    refusal = "disconnected";
    pipeline = new Pipeline({
      runs: openRuns(workspaceDir),
      getCompleteJson: () => provider.complete,
      getLlmInfo: () => ({ provider: "mock", model: "test-model" }),
      google: googleAccess(),
      getTasklistName: () => "Meeting Followups",
    });
  });

  const detailOf = (id: string) => openRuns(workspaceDir).detail(id);
  /* A Run's result is opaque to the Shell (`RunDetail.result: unknown`). This
     Module's result is an ExtractionResult, so parsing it here both narrows the
     type and asserts the stored shape really is the one the Module promises. */
  const resultOf = (detail: { result: unknown } | null): ExtractionResult =>
    ExtractionResultSchema.parse(detail?.result);
  const summariesOf = () => openRuns(workspaceDir).list().runs;

  it("golden transcript → done with task and draft events", async () => {
    const runId = await pipeline.startRun({
      intake: "drive",
      fileName: "meeting.md",
      bytes: Buffer.from("**Dana:** hello\n"),
    });
    await pipeline.idle();
    const detail = detailOf(runId);
    expect(detail).not.toBeNull();
    expect(detail!.status).toBe("done");
    expect(detail!.attempts).toBe(1);
    expect(resultOf(detail).tasks).toHaveLength(2);
    // Identity fields are server-authoritative, not LLM output.
    expect(resultOf(detail).sourceId).toBe(runId);
    expect(resultOf(detail).sourceFileName).toBe("meeting.md");
    expect(resultOf(detail).processedAt).not.toBe("2026-08-18T00:00:00.000Z");
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
    /* The Module's own line, written when the Run ended — the Shell derives
       nothing from the result. */
    expect(summaries[0].summary).toBe("2 tasks, 1 draft");
  });

  it("sniffs the meeting date from a timestamped upload file name", async () => {
    const runId = await pipeline.startRun({
      intake: "drive",
      fileName: "Copy of X-transcript-2026-06-18T13-00-00.000Z.json",
      text: "Richard: hi",
    });
    await pipeline.idle();
    const context = JSON.parse(
      readFileSync(join(workspaceDir, "runs", runId, "context.json"), "utf8"),
    ) as { meetingDate: string | null };
    expect(context.meetingDate).toBe("2026-06-18");
  });

  it("uses externalId as sourceId and honors pre-converted text", async () => {
    const runId = await pipeline.startRun({
      intake: "drive",
      fileName: "Weekly Sync",
      text: "Dana: hello\n",
      sourceUrl: "https://drive.google.com/file/d/abc/view",
      externalId: "drive-123",
    });
    await pipeline.idle();
    const detail = detailOf(runId);
    expect(detail!.status).toBe("done");
    expect(resultOf(detail).sourceId).toBe("drive-123");
    expect(resultOf(detail).sourceUrl).toBe("https://drive.google.com/file/d/abc/view");
    expect(openRuns(workspaceDir).open(runId)!.readArtifact("transcript.txt")).toBe(
      "Dana: hello\n",
    );
    expect(detail!.intake).toBe("drive");
  });

  it("non-transcript → skipped with persisted result and no google calls", async () => {
    provider = scriptedProvider([NON_TRANSCRIPT]);
    const runId = await pipeline.startRun({
      intake: "drive",
      fileName: "spec.pdf",
      text: "A product specification.",
    });
    await pipeline.idle();
    const detail = detailOf(runId);
    expect(detail!.status).toBe("skipped");
    expect(detail!.skipReason).toContain("not a transcript");
    expect(resultOf(detail).isTranscript).toBe(false);
    const types = detail!.events.map((event) => event.type);
    expect(types).toContain("classify_skipped");
    expect(types).toContain("run_done");
    expect(google!.calls.tasks).toHaveLength(0);
  });

  it("provider failure ×3 → failed at extract, each attempt error recorded", async () => {
    provider = { complete: throwingProvider(), attempts: () => 0 };
    const runId = await pipeline.startRun({
      intake: "drive",
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
      intake: "drive",
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

  it("google disconnected → failed at outputs with google_unavailable; retry after connecting", async () => {
    google = null;
    const runId = await pipeline.startRun({
      intake: "drive",
      fileName: "meeting.md",
      text: "hello",
    });
    await pipeline.idle();
    const failed = detailOf(runId);
    expect(failed!.status).toBe("failed");
    expect(failed!.failedStage).toBe("outputs");
    expect(failed!.events.map((event) => event.type)).toContain("google_unavailable");
    expect(failed!.failureHint).toBe(googleFailureHint("disconnected"));
    // Result was persisted before the outputs stage.
    expect(resultOf(failed).isTranscript).toBe(true);

    google = fakeGoogle();
    await pipeline.retryRun(runId);
    await pipeline.idle();
    const retried = detailOf(runId);
    expect(retried!.status).toBe("done");
    expect(retried!.attempts).toBe(1);
    expect(google.calls.tasks).toHaveLength(2);
  });

  it("expired connection → failed at outputs naming the expiry, not a generic retry", async () => {
    // The defect: an expired token used to produce a working surface, so the Run
    // failed with "Retry, or check the events below" and retry could never fix it.
    google = null;
    refusal = "expired";
    const runId = await pipeline.startRun({
      intake: "drive",
      fileName: "meeting.md",
      text: "hello",
    });
    await pipeline.idle();
    const failed = detailOf(runId);
    expect(failed!.status).toBe("failed");
    expect(failed!.failureHint).toBe(googleFailureHint("expired"));
    expect(failed!.connectionCaused).toBe(true);
    const event = failed!.events.find((entry) => entry.type === "google_unavailable");
    expect(event?.detail?.state).toBe("expired");
  });

  it("a grant Google rejects mid-batch stops the batch and names the expiry", async () => {
    const live = fakeGoogle();
    google = {
      ...live,
      createTask: async () => {
        throw Object.assign(new Error("invalid_grant"), {
          response: { data: { error: "invalid_grant" } },
        });
      },
    };
    const runId = await pipeline.startRun({
      intake: "drive",
      fileName: "meeting.md",
      text: "hello",
    });
    await pipeline.idle();
    const failed = detailOf(runId);
    expect(failed!.status).toBe("failed");
    expect(failed!.failedStage).toBe("outputs");
    expect(failed!.failureHint).toBe(googleFailureHint("expired"));
    /* Classified at the failure site where the connection already knows (D6):
       the marker is how every surface later renders Needs attention. */
    expect(failed!.connectionCaused).toBe(true);
    /* Not per-item error events: a dead grant is not one bad task, and every
       remaining call would fail the same way. */
    expect(failed!.events.filter((entry) => entry.type === "google_task_error")).toHaveLength(0);
    expect(failed!.events.filter((entry) => entry.type === "gmail_draft_created")).toHaveLength(0);
    expect(live.calls.drafts).toHaveLength(0);
  });

  it("retry of an extract-failed run re-runs extraction from scratch", async () => {
    provider = scriptedProvider([{ ...GOLDEN, version: 2 }]);
    const runId = await pipeline.startRun({
      intake: "drive",
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
      intake: "drive",
      fileName: "meeting.md",
      text: "hello",
    });
    await pipeline.idle();
    await expect(pipeline.retryRun(runId)).rejects.toThrow(/not retryable/);
  });

  it("conversion failure produces a visible failed run", async () => {
    const runId = await pipeline.startRun({
      intake: "drive",
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
      intake: "drive",
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
      intake: "drive",
      fileName: "meeting.md",
      text: "line\r\nline",
    });
    const transcript = await readFile(join(workspaceDir, "runs", runId, "transcript.txt"), "utf8");
    expect(transcript).toBe("line\r\nline");
  });
});
