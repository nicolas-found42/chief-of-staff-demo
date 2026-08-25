import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigStore } from "../../../apps/server/src/config";
import {
  openGoogleConnection,
  type GoogleConnection,
} from "../../../apps/server/src/google/connection";
import {
  IdeaEngineIntake,
  type DriveFileClient,
} from "../../../apps/server/src/modules/idea-engine/intake";
import { openRuns, type Runs } from "../../../apps/server/src/runs";
import { MAX_UPLOAD_BYTES } from "../../../apps/server/src/text/convert";

let workspaceDir: string;
let configStore: ConfigStore;
let google: GoogleConnection;
let runs: Runs;
let logs: string[];
let listDriveFiles: ReturnType<typeof vi.fn<DriveFileClient["files"]["list"]>>;
let downloadDriveFile: ReturnType<typeof vi.fn<DriveFileClient["files"]["get"]>>;
let exportDriveFile: ReturnType<typeof vi.fn<DriveFileClient["files"]["export"]>>;
function intake(): IdeaEngineIntake {
  return new IdeaEngineIntake({
    getConfig: () => configStore.get(),
    workspaceDir,
    port: 4317,
    startRun: async (spec) => {
      const run = runs.create({
        module: "idea-engine",
        moduleVersion: 1,
        intake: "drive",
        fileName: spec.fileName,
        sourceUrl: spec.sourceUrl,
        externalId: spec.externalId,
      });
      return run.id;
    },
    log: (message) => logs.push(message),
    google,
    getDriveClient: () => ({
      files: {
        list: listDriveFiles,
        get: downloadDriveFile,
        export: exportDriveFile,
      },
    }),
  });
}

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "cos-idea-intake-"));
  configStore = new ConfigStore(join(workspaceDir, "config.json"));
  configStore.load();
  configStore.update({
    drive: {
      enabled: true,
      folderId: "folder-1",
      folderName: "Transcripts",
      pollIntervalMinutes: 2,
    },
    google: { clientId: "id.apps", clientSecret: "secret" },
  });
  configStore.setGoogleRefreshToken("refresh-token");
  google = openGoogleConnection(configStore, 4317, {
    probe: async () => ({ email: "nicolas@found42.com" }),
  });
  runs = openRuns(workspaceDir);
  logs = [];
  listDriveFiles = vi.fn(async () => ({ data: { files: [], nextPageToken: null } }));
  downloadDriveFile = vi.fn(async ({ fileId }) => ({ data: Buffer.from(String(fileId)) }));
  exportDriveFile = vi.fn(async () => ({ data: "Google document text" }));
});

describe("Idea Engine Intake", () => {
  it("does no work when its Drive Intake is disabled", async () => {
    configStore.update({ drive: { enabled: false } });

    await expect(intake().pollOnce()).resolves.toEqual({ created: 0 });
    expect(listDriveFiles).not.toHaveBeenCalled();
  });

  it("skips a poll while the Google connection is unavailable", async () => {
    configStore.setGoogleRefreshToken(null);

    await expect(intake().pollOnce()).resolves.toEqual({ created: 0 });
    expect(logs).toEqual(["IdeaEngine poll skipped: disconnected"]);
    expect(listDriveFiles).not.toHaveBeenCalled();
  });

  it("creates Runs only for supported files and normalizes a Google Doc name", async () => {
    listDriveFiles.mockResolvedValue({
      data: {
        files: [
          {
            id: "file-1",
            name: "meeting.md",
            mimeType: "text/markdown",
            webViewLink: "https://drive.google.test/file-1",
          },
          {
            id: "doc-1",
            name: "Meeting notes",
            mimeType: "application/vnd.google-apps.document",
          },
          { id: "folder", name: "Nested", mimeType: "application/vnd.google-apps.folder" },
          { id: "image", name: "image.png", mimeType: "image/png" },
          {
            id: "large",
            name: "large.md",
            mimeType: "text/markdown",
            size: String(MAX_UPLOAD_BYTES + 1),
          },
          { name: "missing-id.md", mimeType: "text/markdown" },
        ],
        nextPageToken: null,
      },
    });

    await expect(intake().pollOnce()).resolves.toEqual({ created: 2 });

    expect(
      runs
        .list({ module: "idea-engine" })
        .runs.map((run) => ({
          fileName: run.fileName,
          sourceUrl: run.sourceUrl,
          externalId: runs.open(run.id)?.read().externalId,
        }))
        .sort((a, b) => String(a.externalId).localeCompare(String(b.externalId))),
    ).toEqual(
      [
        {
          fileName: "meeting.md",
          sourceUrl: "https://drive.google.test/file-1",
          externalId: "file-1",
        },
        {
          fileName: "Meeting notes.txt",
          sourceUrl: null,
          externalId: "doc-1",
        },
      ].sort((a, b) => a.externalId.localeCompare(b.externalId)),
    );
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.stringContaining("ignoring unsupported file image.png"),
        expect.stringContaining("skipping oversized Drive file large.md"),
      ]),
    );
  });

  it("enumerates every Drive page", async () => {
    listDriveFiles.mockImplementation(async (params) => ({
      data: params.pageToken
        ? {
            files: [{ id: "file-2", name: "second.txt", mimeType: "text/plain" }],
            nextPageToken: null,
          }
        : {
            files: [{ id: "file-1", name: "first.txt", mimeType: "text/plain" }],
            nextPageToken: "page-2",
          },
    }));

    await expect(intake().pollOnce()).resolves.toEqual({ created: 2 });
    expect(listDriveFiles).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ pageToken: "page-2" }),
    );
    expect(runs.list({ module: "idea-engine" }).runs).toHaveLength(2);
  });

  it("continues with the next file after a download failure", async () => {
    listDriveFiles.mockResolvedValue({
      data: {
        files: [
          { id: "fetch-fails", name: "fetch.md", mimeType: "text/markdown" },
          { id: "file-1", name: "meeting.md", mimeType: "text/markdown" },
        ],
        nextPageToken: null,
      },
    });
    downloadDriveFile.mockImplementation(async ({ fileId }) => {
      if (fileId === "fetch-fails") throw new Error("download failed");
      return { data: Buffer.from(String(fileId)) };
    });

    await expect(intake().pollOnce()).resolves.toEqual({ created: 1 });
    expect(runs.list({ module: "idea-engine" }).runs[0]?.fileName).toBe("meeting.md");
    expect(logs).toContain(
      "IdeaEngine failed to fetch Drive file fetch.md (fetch-fails): download failed",
    );
  });

  it("does not recreate a Run for a file seen by an earlier poll", async () => {
    listDriveFiles.mockResolvedValue({
      data: {
        files: [{ id: "file-1", name: "meeting.md", mimeType: "text/markdown" }],
        nextPageToken: null,
      },
    });
    const subject = intake();

    await expect(subject.pollOnce()).resolves.toEqual({ created: 1 });
    await expect(subject.pollOnce()).resolves.toEqual({ created: 0 });
    expect(runs.list({ module: "idea-engine" }).runs).toHaveLength(1);
  });

  it.each([
    [401, "Google not connected"],
    [404, "folder not found or not accessible"],
  ])("turns a Drive %s refusal into a skipped poll", async (code, message) => {
    listDriveFiles.mockRejectedValue(Object.assign(new Error("Drive refused"), { code }));

    await expect(intake().pollOnce()).resolves.toEqual({ created: 0 });
    expect(logs.some((line) => line.includes(message))).toBe(true);
  });

  it("classifies and preserves an unexpected Drive failure", async () => {
    const refusal = Object.assign(new Error("backend unavailable"), { status: 503 });
    listDriveFiles.mockRejectedValue(refusal);

    await expect(intake().pollOnce()).rejects.toThrow("Drive list failed: backend unavailable");
    expect(google.auth().ok).toBe(true);
  });

  it("shares one in-flight poll between overlapping callers", async () => {
    let release: (() => void) | undefined;
    listDriveFiles.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ data: { files: [], nextPageToken: null } });
        }),
    );
    const subject = intake();

    const first = subject.pollOnce();
    const second = subject.pollOnce();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    release?.();

    await expect(Promise.all([first, second])).resolves.toEqual([{ created: 0 }, { created: 0 }]);
    expect(listDriveFiles).toHaveBeenCalledOnce();
  });

  it("starts its timer immediately and reports a background failure", async () => {
    listDriveFiles.mockRejectedValue(new Error("Drive unavailable"));
    const subject = intake();

    subject.start();
    await vi.waitFor(() =>
      expect(logs).toContain("IdeaEngine poll failed: Drive list failed: Drive unavailable"),
    );
    subject.stop();
  });
});
