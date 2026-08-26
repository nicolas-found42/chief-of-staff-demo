import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigStore } from "../../../apps/server/src/config";
import { openRuns } from "../../../apps/server/src/runs";
import { IdeaEngineHost } from "../../../apps/server/src/modules/idea-engine/host";
import type { GoogleConnection } from "../../../apps/server/src/google/connection";
import {
  loadState,
  saveState,
  hasSeenForModule,
  rememberSeenForModule,
} from "../../../apps/server/src/state";
import { workspaceLayout } from "../../../apps/server/src/paths";
import {
  IDEA_CONTENT_TYPES,
  IDEA_ENGINE_MODULE_ID,
  IDEA_ENGINE_MODULE_VERSION,
} from "@chief-of-staff-demo/shared";
import type { Runs } from "../../../apps/server/src/runs";

const PORT = 4317;

let app: FastifyInstance;
let workspaceDir: string;
let configStore: ConfigStore;
let host: IdeaEngineHost;
let runs: Runs;
let driveFiles: Array<{
  id: string;
  name: string;
  mimeType: string;
  webViewLink?: string;
  size?: string;
}>;
let driveGetCalls: string[];
let googleState: "connected" | "disconnected" | "expired" | "unconfigured";

function makeDriveClient() {
  return {
    files: {
      list: async () => ({
        data: {
          files: driveFiles,
          nextPageToken: null,
        },
      }),
      get: async ({ fileId }: { fileId: string }) => {
        driveGetCalls.push(fileId);
        // return minimal buffer
        const file = driveFiles.find((f) => f.id === fileId);
        const content = `Transcript for ${file?.name ?? fileId}`;
        return { data: Buffer.from(content, "utf8") } as unknown as { data: unknown };
      },
      export: async ({ fileId }: { fileId: string }) => {
        driveGetCalls.push(fileId);
        const file = driveFiles.find((f) => f.id === fileId);
        const content = `Transcript for ${file?.name ?? fileId}`;
        return { data: Buffer.from(content, "utf8") } as unknown as { data: unknown };
      },
    },
  } as unknown as import("../../../apps/server/src/modules/idea-engine/intake").DriveFileClient;
}

/** scripted LLM that returns empty ideas for all types (so Run completes as 0 ideas but still done) */
function scriptedComplete() {
  return async () => ({ ideas: [], reason: "no hook" });
}

beforeEach(async () => {
  workspaceDir = mkdtempSync(join(tmpdir(), "idea-backfill-"));
  mkdirSync(join(workspaceDir, "runs"), { recursive: true });
  configStore = new ConfigStore(join(workspaceDir, "config.json"));
  configStore.load();
  configStore.update({
    drive: {
      enabled: true,
      folderId: "folder-123",
      folderName: "Transcripts",
      pollIntervalMinutes: 2,
    },
    provider: "mock",
    model: "mock-model",
    apiKey: "test-key",
  });
  configStore.setGoogleRefreshToken("refresh-token");

  driveFiles = [];
  driveGetCalls = [];
  googleState = "connected";

  runs = openRuns(workspaceDir);
  const fakeGoogle = {
    state: async () => ({ state: googleState, expiresAt: null }),
    auth: () =>
      googleState === "connected"
        ? { ok: true, auth: { fake: true } }
        : { ok: false, state: googleState },
    observe: () => null,
  } as unknown as GoogleConnection;

  host = new IdeaEngineHost({
    runs,
    configStore,
    workspaceDir,
    port: PORT,
    google: fakeGoogle,
    log: () => {},
    getDriveClient: () => makeDriveClient(),
    getCompleteJson: scriptedComplete,
    getSheetsClient: () => ({
      ensureTab: async () => {},
      ensureTabWithMigration: async () => {},
      appendRows: async () => {},
      isMissing: () => false,
    }),
    getGmailClient: () => ({
      createDraft: async () => "draft-1",
    }),
  });

  app = fastify({ logger: false });
  host.routes(app);
  await app.ready();
});

afterEach(async () => {
  host.stop();
  await host.idle();
  await app.close();
});

describe("IdeaEngineHost lifecycle", () => {
  it("recovers an orphaned Run when the Host starts", async () => {
    const orphan = runs.create({
      module: IDEA_ENGINE_MODULE_ID,
      moduleVersion: IDEA_ENGINE_MODULE_VERSION,
      intake: "drive",
      fileName: "chosen-transcript.md",
      sourceUrl: "https://drive.google.com/file/d/chosen/view",
      externalId: "chosen-transcript",
    });
    orphan.writeArtifact("transcript.txt", "Richard: A durable content idea.\n");
    orphan.writeArtifact("context.json", '{"attendees":[]}\n');
    orphan.started(IDEA_CONTENT_TYPES[0]);

    host.start();
    await host.idle();

    expect(runs.detail(orphan.id)?.status).toBe("done");
    expect(
      runs.detail(orphan.id)?.events.find((event) => event.type === "run_recovered")?.detail,
    ).toEqual({
      fromStage: IDEA_CONTENT_TYPES[0],
      previousStatus: "running",
      reason: "durable_progress_selected_first_incomplete_stage",
    });
  });
});

/**
 * HTTP seam: POST /api/idea-engine/backfill via app.inject over a real Fastify
 * instance, temp Workspace, fake Drive, real Runs. Assertions through the public
 * HTTP response and the Runs list — not by reaching into internals.
 */
describe("POST /api/idea-engine/backfill", () => {
  it("creates one Run per unseen Drive file and records hasSeen", async () => {
    driveFiles = [
      {
        id: "drive-1",
        name: "meeting-2026-08-24.md",
        mimeType: "text/markdown",
        webViewLink: "https://drive.google.com/file/d/drive-1",
      },
      {
        id: "drive-2",
        name: "meeting-2026-08-23.md",
        mimeType: "text/markdown",
        webViewLink: "https://drive.google.com/file/d/drive-2",
      },
    ];

    const response = await app.inject({ method: "POST", url: "/api/idea-engine/backfill" });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.created).toBe(2);
    expect(body.skipped).toBe(0);

    // Second call with same files is idempotent — hasSeen dedup at the HTTP seam
    const second = await app.inject({ method: "POST", url: "/api/idea-engine/backfill" });
    expect(second.json()).toEqual({ created: 0, skipped: 2 });

    const runs = openRuns(workspaceDir);
    const list = runs.list({ module: "idea-engine" });
    expect(list.runs).toHaveLength(2);

    // hasSeen is namespaced — the same durable file, ideaEngine slice
    const layout = workspaceLayout(workspaceDir);
    expect(hasSeenForModule(layout.stateFile, "idea-engine", "drive-1")).toBe(true);
    expect(hasSeenForModule(layout.stateFile, "idea-engine", "drive-2")).toBe(true);
  });

  it("respects existing Run externalId even when hasSeen is empty", async () => {
    driveFiles = [
      { id: "drive-1", name: "meeting-a.md", mimeType: "text/markdown" },
      { id: "drive-2", name: "meeting-b.md", mimeType: "text/markdown" },
    ];
    // Pre-create a Run with externalId drive-1 via the host's Runner path by first backfill,
    // then wipe hasSeen to simulate a state file that lost the ideaEngine slice.
    {
      const first = await app.inject({ method: "POST", url: "/api/idea-engine/backfill" });
      expect(first.json().created).toBe(2);
    }
    // Wipe ideaEngine hasSeen but keep the Run — backfill must still skip via existingExternalIds
    const layout = workspaceLayout(workspaceDir);
    const state = loadState(layout.stateFile);
    state.ideaEngine.ingestedIds = [];
    saveState(layout.stateFile, state);

    // Reset drive files to same set — second backfill should see existing Runs and skip, not recreate
    driveFiles = [
      { id: "drive-1", name: "meeting-a.md", mimeType: "text/markdown" },
      { id: "drive-2", name: "meeting-b.md", mimeType: "text/markdown" },
    ];

    const second = await app.inject({ method: "POST", url: "/api/idea-engine/backfill" });
    const body = second.json();
    // Both files already have a Run with that externalId, so skipped via existingExternalIds
    expect(body).toEqual({ created: 0, skipped: 2 });

    const runs = openRuns(workspaceDir);
    expect(runs.list({ module: "idea-engine" }).runs).toHaveLength(2);
  });

  it("isolation: drive.ingestedIds does not block idea-engine backfill", async () => {
    driveFiles = [{ id: "drive-shared", name: "shared.md", mimeType: "text/markdown" }];

    // Seed the transcript Module's memory — same state file, different namespace
    const layout = workspaceLayout(workspaceDir);
    const state = loadState(layout.stateFile);
    state.drive.ingestedIds = ["drive-shared"];
    saveState(layout.stateFile, state);

    // idea-engine hasSeen is still empty, so backfill must create the Run
    const response = await app.inject({ method: "POST", url: "/api/idea-engine/backfill" });
    expect(response.json()).toEqual({ created: 1, skipped: 0 });

    // Verify the isolation: drive slice still has it, ideaEngine slice now has it too after backfill
    const after = loadState(layout.stateFile);
    expect(after.drive.ingestedIds).toContain("drive-shared");
    expect(after.ideaEngine.ingestedIds).toContain("drive-shared");
    // But hasSeenForModule checks the right namespace: drive slice alone would not have blocked us above
    expect(hasSeenForModule(layout.stateFile, "idea-engine", "drive-shared")).toBe(true);
  });

  it("caps at 1000 and evicts oldest (FIFO) — backfill can recreate the evicted file", async () => {
    const layout = workspaceLayout(workspaceDir);
    // Seed 1000 entries
    const state = loadState(layout.stateFile);
    for (let i = 0; i < 1000; i++) {
      state.ideaEngine.ingestedIds.push(`evict-${i}`);
    }
    saveState(layout.stateFile, state);
    expect(loadState(layout.stateFile).ideaEngine.ingestedIds).toHaveLength(1000);
    expect(hasSeenForModule(layout.stateFile, "idea-engine", "evict-0")).toBe(true);

    // Add the 1001st via rememberSeenForModule — oldest evicted
    rememberSeenForModule(layout.stateFile, "idea-engine", "evict-1000");
    const after = loadState(layout.stateFile);
    expect(after.ideaEngine.ingestedIds).toHaveLength(1000);
    expect(after.ideaEngine.ingestedIds).not.toContain("evict-0");
    expect(after.ideaEngine.ingestedIds).toContain("evict-1000");
    expect(hasSeenForModule(layout.stateFile, "idea-engine", "evict-0")).toBe(false);

    // Backfill of the evicted id must be allowed again (FIFO cap)
    driveFiles = [{ id: "evict-0", name: "evicted.md", mimeType: "text/markdown" }];
    const response = await app.inject({ method: "POST", url: "/api/idea-engine/backfill" });
    expect(response.json()).toEqual({ created: 1, skipped: 0 });
  });

  it("returns 400 when Google is not connected, with a hint the Settings page can act on", async () => {
    googleState = "disconnected";
    driveFiles = [{ id: "drive-1", name: "meeting.md", mimeType: "text/markdown" }];
    const response = await app.inject({ method: "POST", url: "/api/idea-engine/backfill" });
    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.error).toMatch(/Reconnect|Settings|Google/i);
  });

  it("ignores unsupported file types (skipped without a Run) — not a failure", async () => {
    driveFiles = [
      { id: "drive-png", name: "photo.png", mimeType: "image/png" },
      { id: "drive-md", name: "notes.md", mimeType: "text/markdown" },
    ];
    const response = await app.inject({ method: "POST", url: "/api/idea-engine/backfill" });
    const body = response.json();
    expect(body.created).toBe(1);
    const runs = openRuns(workspaceDir);
    const list = runs.list({ module: "idea-engine" });
    expect(list.runs).toHaveLength(1);
    const handle = runs.open(list.runs[0].id);
    expect(handle).not.toBeNull();
    expect(handle!.read().externalId).toBe("drive-md");
  });
});
