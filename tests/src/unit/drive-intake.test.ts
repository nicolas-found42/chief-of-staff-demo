import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigStore } from "../../../apps/server/src/config";
import { DriveIntake, type DriveFileClient } from "../../../apps/server/src/intake/drive";
import { loadState, saveState } from "../../../apps/server/src/state";
import { Pipeline } from "../../../apps/server/src/pipeline/run";
import { openRuns } from "../../../apps/server/src/runs";
import type { CompleteJson } from "../../../apps/server/src/llm/providers";
import type { GoogleOutputs } from "../../../apps/server/src/google/outputs";
import type { GoogleConnection } from "../../../apps/server/src/google/connection";
import { composeTaskNotes } from "../../../apps/server/src/google/tasks";
import { workspaceLayout } from "../../../apps/server/src/paths";
const PORT = 4317;

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
  ],
  drafts: [{ to: "", subject: "Updated pricing", body: "Hello,", reason: "Acme needs telling." }],
};

interface FakeGoogle extends GoogleOutputs {
  calls: { tasklists: string[]; tasks: unknown[]; drafts: unknown[] };
}
function fakeGoogle(): FakeGoogle {
  const g: FakeGoogle = {
    calls: { tasklists: [], tasks: [], drafts: [] },
    findOrCreateTasklist: async (title: string) => {
      g.calls.tasklists.push(title);
      return "list-1";
    },
    createTask: async (_id, item, source) => {
      g.calls.tasks.push({ title: item.title, notes: composeTaskNotes(item, source) });
      return `task-${g.calls.tasks.length}`;
    },
    createDraft: async (draft) => {
      g.calls.drafts.push({ subject: draft.subject });
      return `draft-${g.calls.drafts.length}`;
    },
  };
  return g;
}

function scriptedProvider(script: unknown[]): { complete: CompleteJson; attempts: () => number } {
  let calls = 0;
  return {
    complete: async () => {
      const next = script[Math.min(calls, script.length - 1)];
      calls += 1;
      if (next === "THROW") throw new Error("boom");
      return next;
    },
    attempts: () => calls,
  };
}

describe.sequential("DriveIntake", () => {
  let workspaceDir: string;
  let configStore: ConfigStore;
  let pipeline: Pipeline;
  let provider: { complete: CompleteJson; attempts: () => number };
  let google: FakeGoogle;
  let intakeGoogle: GoogleConnection;
  let logs: string[];
  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "drive-intake-"));
    configStore = new ConfigStore(join(workspaceDir, "config.json"));
    configStore.load();
    configStore.update({
      drive: { enabled: true, folderId: "folder123", folderName: "Test", pollIntervalMinutes: 2 },
      google: { clientId: "id", clientSecret: "secret" },
    });
    configStore.setGoogleRefreshToken("refresh-token");
    google = fakeGoogle();
    provider = scriptedProvider([GOLDEN]);
    pipeline = new Pipeline({
      runs: openRuns(workspaceDir),
      getCompleteJson: () => provider.complete,
      getLlmInfo: () => ({ provider: "mock", model: "test" }),
      google: {
        outputs: () => ({ ok: true as const, outputs: google }),
        observe: () => null,
      },
      getTasklistName: () => "Meeting Followups",
    });
    logs = [];
    intakeGoogle = {
      state: async () => {
        const cfg = configStore.get();
        if (!cfg.google.clientId || !cfg.google.clientSecret) {
          return { state: "unconfigured", email: null, redirectUri: "", scopes: [], lastConnectedAt: null, expiresAbout: null } as unknown as ReturnType<GoogleConnection["state"]> extends Promise<infer T> ? T : never;
        }
        if (!cfg.google.refreshToken) {
          return { state: "disconnected", email: null, redirectUri: "", scopes: [], lastConnectedAt: null, expiresAbout: null } as unknown as ReturnType<GoogleConnection["state"]> extends Promise<infer T> ? T : never;
        }
        return { state: "connected", email: "test@example.com", redirectUri: "", scopes: [], lastConnectedAt: new Date().toISOString(), expiresAbout: null } as unknown as ReturnType<GoogleConnection["state"]> extends Promise<infer T> ? T : never;
      },
      outputs: () => ({ ok: true, outputs: google } as unknown as ReturnType<GoogleConnection["outputs"]>),
      observe: vi.fn(() => null),
      verifySetup: async () => ({ state: "connected", items: [] }),
      authUrl: () => ({ ok: false, state: "unconfigured" }),
      completeSignIn: async () => {},
      disconnect: () => {},
      invalidate: () => {},
      pickerToken: async () => ({ ok: false, state: "disconnected" }),
    } as unknown as GoogleConnection;
  });
  function makeDrive(
    files: Array<{ id: string; name: string; mimeType?: string; webViewLink?: string | null; size?: string }>,
    fileData: Record<string, Buffer | string> = {}
  ): DriveFileClient {
    return {
      files: {
        list: async () => ({ data: { files, nextPageToken: undefined } }),
        get: async (params: Record<string, unknown>) => {
          const fileId = params.fileId as string;
          const data = fileData[fileId];
          if (data === undefined) return { data: Buffer.from("hello world") };
          return { data };
        },
        export: async (params: Record<string, unknown>) => {
          const fileId = params.fileId as string;
          const data = fileData[fileId];
          if (data === undefined) return { data: Buffer.from("exported text") };
          return { data };
        },
      },
    };
  }

  function intakeWith(drive: DriveFileClient, overrideGoogle?: GoogleConnection) {
    return new DriveIntake({
      getConfig: () => configStore.get(),
      workspaceDir,
      port: PORT,
      startRun: (spec) => pipeline.startRun(spec),
      log: (m) => logs.push(m),
      google: overrideGoogle ?? intakeGoogle,
      getDriveClient: () => drive,
    });
  }

  it("gates: does nothing when disabled", async () => {
    configStore.update({ drive: { enabled: false, folderId: "folder123" } });
    const drive = makeDrive([{ id: "1", name: "a.txt" }]);
    const listSpy = vi.spyOn(drive.files, "list");
    const intake = intakeWith(drive);
    const { created } = await intake.pollOnce();
    await pipeline.idle();
    expect(created).toBe(0);
    expect(listSpy).not.toHaveBeenCalled();
    expect(openRuns(workspaceDir).list()).toHaveLength(0);
    const state = loadState(join(workspaceDir, "state.json"));
    expect(state.drive.lastPollAt).not.toBeNull();
  });

  it("gates: does nothing when folderId is empty", async () => {
    configStore.update({ drive: { folderId: "" } });
    const drive = makeDrive([{ id: "1", name: "a.txt" }]);
    const listSpy = vi.spyOn(drive.files, "list");
    const intake = intakeWith(drive);
    const { created } = await intake.pollOnce();
    await pipeline.idle();
    expect(created).toBe(0);
    expect(listSpy).not.toHaveBeenCalled();
  });

  it("gates: skips when Google not connected", async () => {
    configStore.setGoogleRefreshToken(null);
    const drive = makeDrive([{ id: "1", name: "a.txt" }]);
    const listSpy = vi.spyOn(drive.files, "list");
    const intake = intakeWith(drive);
    const { created } = await intake.pollOnce();
    await pipeline.idle();
    expect(created).toBe(0);
    expect(listSpy).not.toHaveBeenCalled();
    expect(logs.join(" ")).toMatch(/not connected/i);
  });

  it("inaccessible folder (404) logs and creates no Runs", async () => {
    const drive: DriveFileClient = {
      files: {
        list: async () => {
          const err = Object.assign(new Error("File not found"), { code: 404 });
          throw err;
        },
        get: async () => ({ data: Buffer.from("") }),
        export: async () => ({ data: Buffer.from("") }),
      },
    };
    const intake = intakeWith(drive);
    const { created } = await intake.pollOnce();
    await pipeline.idle();
    expect(created).toBe(0);
    expect(openRuns(workspaceDir).list()).toHaveLength(0);
    expect(logs.join(" ")).toMatch(/not found or not accessible/);
    const state = loadState(join(workspaceDir, "state.json"));
    expect(state.drive.ingestedIds).toHaveLength(0);
  });

  it("inaccessible folder (403) logs and creates no Runs", async () => {
    const drive: DriveFileClient = {
      files: {
        list: async () => {
          const err = Object.assign(new Error("The user does not have sufficient permissions"), { code: 403 });
          throw err;
        },
        get: async () => ({ data: Buffer.from("") }),
        export: async () => ({ data: Buffer.from("") }),
      },
    };
    const intake = intakeWith(drive);
    const { created } = await intake.pollOnce();
    expect(created).toBe(0);
    expect(logs.join(" ")).toMatch(/not found or not accessible/);
  });

  it("empty folder creates 0 Runs", async () => {
    const drive = makeDrive([]);
    const intake = intakeWith(drive);
    const { created } = await intake.pollOnce();
    await pipeline.idle();
    expect(created).toBe(0);
    expect(openRuns(workspaceDir).list()).toHaveLength(0);
  });

  it("mixed folder: two supported, one image, one subfolder → 2 Runs, image/subfolder ignored", async () => {
    const files = [
      { id: "1", name: "meeting.txt", mimeType: "text/plain", webViewLink: "https://drive.google.com/file/d/1/view" },
      { id: "2", name: "notes.md", mimeType: "text/markdown" },
      { id: "3", name: "photo.png", mimeType: "image/png" },
      { id: "4", name: "Subfolder", mimeType: "application/vnd.google-apps.folder" },
    ];
    const data: Record<string, Buffer> = {
      "1": Buffer.from("Dana: hello\nSam: hi\n"),
      "2": Buffer.from("# Notes\nAlice: hi\n"),
    };
    const drive = makeDrive(files, data);
    const intake = intakeWith(drive);
    const { created } = await intake.pollOnce();
    await pipeline.idle();
    expect(created).toBe(2);
    const runs = openRuns(workspaceDir).list();
    expect(runs).toHaveLength(2);
    expect(logs.join(" ")).toMatch(/Ignoring unsupported file.*photo\.png/);
    const failed = runs.filter((r) => r.status === "failed");
    expect(failed).toHaveLength(0);
    // Order is by createdAt descending, so check by fileName
    const byName = Object.fromEntries(runs.map(r => {
      const d = openRuns(workspaceDir).detail(r.id)!;
      return [d.fileName, d];
    }));
    expect(byName["meeting.txt"]?.source).toBe("drive");
    expect(byName["meeting.txt"]?.sourceUrl).toBe("https://drive.google.com/file/d/1/view");
    expect(byName["notes.md"]?.source).toBe("drive");
    // notes.md had no webViewLink, so null is fine
    expect(byName["notes.md"] !== undefined).toBe(true);
  });

  it("dedupe: duplicate fileId on second poll creates 0 new Runs", async () => {
    const files = [
      { id: "dup1", name: "a.txt", mimeType: "text/plain" },
      { id: "dup2", name: "b.md", mimeType: "text/markdown" },
    ];
    const drive = makeDrive(files, {
      dup1: Buffer.from("Alice: hi\n"),
      dup2: Buffer.from("Bob: hello\n"),
    });
    const intake = intakeWith(drive);
    const first = await intake.pollOnce();
    await pipeline.idle();
    expect(first.created).toBe(2);
    expect(openRuns(workspaceDir).list()).toHaveLength(2);

    const second = await intake.pollOnce();
    await pipeline.idle();
    expect(second.created).toBe(0);
    expect(openRuns(workspaceDir).list()).toHaveLength(2);
    const state = loadState(join(workspaceDir, "state.json"));
    expect(state.drive.ingestedIds).toEqual(["dup1", "dup2"]);
  });

  it("Google Doc export via drive.files.export creates a Run with .txt effectiveName", async () => {
    const files = [{ id: "doc1", name: "Meeting Notes", mimeType: "application/vnd.google-apps.document", webViewLink: "https://docs.google.com/document/d/doc1" }];
    const drive: DriveFileClient = {
      files: {
        list: async () => ({ data: { files, nextPageToken: undefined } }),
        get: async () => {
          throw new Error("should not call get for Docs");
        },
        export: async (params: Record<string, unknown>) => {
          expect(params.fileId).toBe("doc1");
          expect(params.mimeType).toBe("text/plain");
          return { data: Buffer.from("Priya: exported doc text\n") };
        },
      },
    };
    const intake = intakeWith(drive);
    const { created } = await intake.pollOnce();
    await pipeline.idle();
    expect(created).toBe(1);
    const runs = openRuns(workspaceDir).list();
    expect(runs).toHaveLength(1);
    const detail = openRuns(workspaceDir).detail(runs[0].id)!;
    expect(detail.fileName).toBe("Meeting Notes.txt");
    expect(detail.source).toBe("drive");
    expect(detail.result?.sourceId).toBe("doc1");
    expect(detail.sourceUrl).toBe("https://docs.google.com/document/d/doc1");
    const context = JSON.parse(readFileSync(join(workspaceDir, "runs", runs[0].id, "context.json"), "utf8")) as { meetingDate: string | null };
    expect(context.meetingDate).toBeNull();
  });
  it("media fetch via drive.files.get for normal files", async () => {
    const files = [{ id: "f1", name: "transcript.txt", mimeType: "text/plain", webViewLink: "https://drive.google.com/file/d/f1/view" }];
    let getCalled = false;
    const drive: DriveFileClient = {
      files: {
        list: async () => ({ data: { files, nextPageToken: undefined } }),
        get: async (params: Record<string, unknown>) => {
          expect(params.fileId).toBe("f1");
          getCalled = true;
          return { data: Buffer.from("Dana: via media\n") };
        },
        export: async () => {
          throw new Error("should not export");
        },
      },
    };
    const intake = intakeWith(drive);
    const { created } = await intake.pollOnce();
    await pipeline.idle();
    expect(created).toBe(1);
    expect(getCalled).toBe(true);
  });

  it("JSONC with // and /* */ comments parses and creates a Run", async () => {
    const jsonc = `// transcript
[
  // first speaker
  { "speaker_name": "Alice", "text": "hello", "index": 0 },
  /* second */
  { "speaker_name": "Bob", "text": "hi", "index": 1 }
]
`;
    const files = [{ id: "j1", name: "meet.jsonc", mimeType: "application/json" }];
    const drive = makeDrive(files, { j1: Buffer.from(jsonc) });
    const intake = intakeWith(drive);
    const { created } = await intake.pollOnce();
    await pipeline.idle();
    expect(created).toBe(1);
    const runs = openRuns(workspaceDir).list();
    expect(runs).toHaveLength(1);
    const detail = openRuns(workspaceDir).detail(runs[0].id)!;
    expect(detail.status).not.toBe("failed");
    expect(detail.failedStage).not.toBe("convert");
    const transcript = readFileSync(join(workspaceDir, "runs", runs[0].id, "transcript.txt"), "utf8");
    expect(transcript).toBe("Alice: hello\nBob: hi");
  });

  it("JSONC block comments stripped correctly", async () => {
    const jsonc = `/* header comment */
[
  { "speaker_name": "A", "text": "one", "index": 0 } /* inline */,
  { "speaker_name": "B", "text": "two", "index": 1 }
] /* footer */`;
    const files = [{ id: "j2", name: "block.jsonc", mimeType: "application/json" }];
    const drive = makeDrive(files, { j2: Buffer.from(jsonc) });
    const intake = intakeWith(drive);
    const { created } = await intake.pollOnce();
    await pipeline.idle();
    expect(created).toBe(1);
    const transcript = readFileSync(join(workspaceDir, "runs", openRuns(workspaceDir).list()[0].id, "transcript.txt"), "utf8");
    expect(transcript).toBe("A: one\nB: two");
  });

  it("malformed transcript (.json wrapped object) becomes failed Run at convert", async () => {
    const malformed = JSON.stringify({ sentences: [{ speaker_name: "A", text: "hi", index: 0 }] });
    const files = [{ id: "bad1", name: "bad.json", mimeType: "application/json" }];
    const drive = makeDrive(files, { bad1: Buffer.from(malformed) });
    const intake = intakeWith(drive);
    const { created } = await intake.pollOnce();
    await pipeline.idle();
    expect(created).toBe(1);
    const runs = openRuns(workspaceDir).list();
    expect(runs).toHaveLength(1);
    const detail = openRuns(workspaceDir).detail(runs[0].id)!;
    expect(detail.status).toBe("failed");
    expect(detail.failedStage).toBe("convert");
    expect(detail.failureHint).toBe("This file could not be converted to text.");
    await expect(pipeline.retryRun(detail.id)).rejects.toThrow(/not retryable/);
    const second = await intake.pollOnce();
    await pipeline.idle();
    expect(second.created).toBe(0);
    expect(openRuns(workspaceDir).list()).toHaveLength(1);
  });

  it("malformed JSONC that is not a sentences array also fails at convert", async () => {
    const malformed = `// comment
{ "not": "an array" }`;
    const files = [{ id: "bad2", name: "bad2.jsonc", mimeType: "application/json" }];
    const drive = makeDrive(files, { bad2: Buffer.from(malformed) });
    const intake = intakeWith(drive);
    const { created } = await intake.pollOnce();
    await pipeline.idle();
    expect(created).toBe(1);
    const detail = openRuns(workspaceDir).detail(openRuns(workspaceDir).list()[0].id)!;
    expect(detail.failedStage).toBe("convert");
  });

  it("oversized file via size field is skipped with log and no Run", async () => {
    const files = [
      { id: "big", name: "huge.pdf", mimeType: "application/pdf", size: String(11 * 1024 * 1024) },
      { id: "small", name: "ok.txt", mimeType: "text/plain", size: String(100) },
    ];
    const drive = makeDrive(files, { small: Buffer.from("Alice: ok\n") });
    let bigFetched = false;
    const origGet = drive.files.get;
    drive.files.get = async (params: Record<string, unknown>, opts?: Record<string, unknown>) => {
      if ((params.fileId as string) === "big") {
        bigFetched = true;
        return { data: Buffer.alloc(11 * 1024 * 1024) };
      }
      return origGet(params, opts);
    };
    const intake = intakeWith(drive);
    const { created } = await intake.pollOnce();
    await pipeline.idle();
    expect(created).toBe(1);
    expect(bigFetched).toBe(false);
    expect(logs.join(" ")).toMatch(/Skipping oversized.*huge\.pdf/);
    const runs = openRuns(workspaceDir).list();
    expect(runs).toHaveLength(1);
    expect(runs[0].fileName).toBe("ok.txt");
    const state = loadState(join(workspaceDir, "state.json"));
    expect(state.drive.ingestedIds).not.toContain("big");
    expect(state.drive.ingestedIds).toContain("small");
  });

  it("oversized file via bytes length (when size missing) is skipped", async () => {
    const files = [{ id: "big2", name: "huge2.txt", mimeType: "text/plain" }];
    const drive: DriveFileClient = {
      files: {
        list: async () => ({ data: { files, nextPageToken: undefined } }),
        get: async () => ({ data: Buffer.alloc(11 * 1024 * 1024, "a") }),
        export: async () => ({ data: Buffer.from("") }),
      },
    };
    const intake = intakeWith(drive);
    const { created } = await intake.pollOnce();
    await pipeline.idle();
    expect(created).toBe(0);
    expect(openRuns(workspaceDir).list()).toHaveLength(0);
    expect(logs.join(" ")).toMatch(/Skipping oversized/);
  });

  it("caps ingestedIds at 1000 with FIFO eviction", async () => {
    const layout = workspaceLayout(workspaceDir);
    const state = loadState(layout.stateFile);
    state.drive.ingestedIds = Array.from({ length: 1000 }, (_, i) => `old-${i}`);
    saveState(layout.stateFile, state);

    const files = [{ id: "new-1", name: "new.txt", mimeType: "text/plain" }];
    const drive = makeDrive(files, { "new-1": Buffer.from("Bob: new\n") });
    const intake = intakeWith(drive);
    const { created } = await intake.pollOnce();
    await pipeline.idle();
    expect(created).toBe(1);
    const nextState = loadState(layout.stateFile);
    expect(nextState.drive.ingestedIds).toHaveLength(1000);
    expect(nextState.drive.ingestedIds).not.toContain("old-0");
    expect(nextState.drive.ingestedIds).toContain("old-1");
    expect(nextState.drive.ingestedIds).toContain("new-1");
  });

  it("updates state.drive.lastPollAt on every poll attempt (even when gated)", async () => {
    configStore.update({ drive: { enabled: false } } as unknown as Record<string, unknown>);
    const drive = makeDrive([]);
    const intake = intakeWith(drive);
    const before = loadState(join(workspaceDir, "state.json")).drive.lastPollAt;
    expect(before).toBeNull();
    await intake.pollOnce();
    const after = loadState(join(workspaceDir, "state.json")).drive.lastPollAt;
    expect(after).not.toBeNull();
    expect(new Date(after as string).getTime()).toBeGreaterThan(Date.now() - 5000);
  });

  it("sets Run sourceUrl, externalId, fileName, and meetingDate from file name", async () => {
    const files = [
      {
        id: "meet1",
        name: "Copy of Call-transcript-2026-06-18T13-00-00.000Z.txt",
        mimeType: "text/plain",
        webViewLink: "https://drive.google.com/file/d/meet1/view",
      },
    ];
    const drive = makeDrive(files, { meet1: Buffer.from("Dana: dated\n") });
    const intake = intakeWith(drive);
    const { created } = await intake.pollOnce();
    await pipeline.idle();
    expect(created).toBe(1);
    const runs = openRuns(workspaceDir).list();
    const detail = openRuns(workspaceDir).detail(runs[0].id)!;
    expect(detail.source).toBe("drive");
    expect(detail.result?.sourceId).toBe("meet1");
    expect(detail.sourceUrl).toBe("https://drive.google.com/file/d/meet1/view");
    expect(detail.fileName).toBe("Copy of Call-transcript-2026-06-18T13-00-00.000Z.txt");
    const context = JSON.parse(readFileSync(join(workspaceDir, "runs", detail.id, "context.json"), "utf8")) as { meetingDate: string | null };
    expect(context.meetingDate).toBe("2026-06-18");
  });

  it("handles pagination via nextPageToken", async () => {
    const page1 = [{ id: "p1", name: "a.txt", mimeType: "text/plain" }];
    const page2 = [{ id: "p2", name: "b.txt", mimeType: "text/plain" }];
    let call = 0;
    const drive: DriveFileClient = {
      files: {
        list: async (params: Record<string, unknown>) => {
          call += 1;
          if (call === 1) {
            expect(params.pageToken).toBeUndefined();
            return { data: { files: page1, nextPageToken: "tok" } };
          }
          expect(params.pageToken).toBe("tok");
          return { data: { files: page2, nextPageToken: undefined } };
        },
        get: async () => ({ data: Buffer.from("Alice: hi\n") }),
        export: async () => ({ data: Buffer.from("") }),
      },
    };
    const intake = intakeWith(drive);
    const { created } = await intake.pollOnce();
    await pipeline.idle();
    expect(created).toBe(2);
    expect(openRuns(workspaceDir).list()).toHaveLength(2);
  });
});
