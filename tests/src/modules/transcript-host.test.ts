import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigStore } from "../../../apps/server/src/config";
import { openGoogleConnection } from "../../../apps/server/src/google/connection";
import { TranscriptHost } from "../../../apps/server/src/modules/transcript/host";
import {
  TRANSCRIPT_MODULE_ID,
  TRANSCRIPT_MODULE_VERSION,
} from "../../../apps/server/src/modules/transcript/module";
import { openRuns, type Runs } from "../../../apps/server/src/runs";

const PORT = 4317;

let app: FastifyInstance;
let workspaceDir: string;
let runs: Runs;
let configStore: ConfigStore;
let host: TranscriptHost;

beforeEach(async () => {
  workspaceDir = mkdtempSync(join(tmpdir(), "cos-transcript-host-"));
  runs = openRuns(workspaceDir);
  configStore = new ConfigStore(join(workspaceDir, "config.json"));
  configStore.load();

  host = new TranscriptHost({
    runs,
    workspaceDir,
    port: PORT,
    getConfig: () => configStore.get(),
    getCompleteJson: () => async () => ({
      version: 1,
      sourceId: "",
      sourceFileName: "",
      sourceUrl: null,
      processedAt: "2026-08-25T00:00:00.000Z",
      isTranscript: false,
      skipReason: "Not a transcript",
      summary: "",
      tasks: [],
      drafts: [],
    }),
    getLlmInfo: () => ({ provider: "mock", model: "mock-model" }),
    google: openGoogleConnection(configStore, PORT, {
      probe: async () => ({ email: "nicolas@found42.com" }),
    }),
    log: () => {},
  });

  app = fastify({ logger: false });
  host.routes(app);
  await app.ready();
});

afterEach(async () => {
  host.stop();
  await app.close();
});

describe("TranscriptHost", () => {
  it("serves remembered Intake status without contacting Google", async () => {
    host.start();
    const status = await app.inject({ method: "GET", url: "/api/intake/drive" });

    expect(status.json()).toEqual({
      enabled: false,
      configured: false,
      folderName: "",
      pollIntervalMinutes: 2,
      lastPollAt: null,
      lastPollOutcome: null,
    });
  });

  it("reports that a disabled Intake created no Runs", async () => {
    const response = await app.inject({ method: "POST", url: "/api/drive/sync" });

    expect(response.json()).toEqual({ created: 0 });
  });

  it("starts work through the Module", async () => {
    const id = await host.startRun({
      intake: "manual",
      fileName: "notes.txt",
      text: "A product specification.",
    });

    await vi.waitFor(() => expect(runs.detail(id)?.status).toBe("skipped"));
  });

  it("recovers an orphaned transcript Run on boot in place from extraction", async () => {
    const orphan = runs.create({
      module: TRANSCRIPT_MODULE_ID,
      moduleVersion: TRANSCRIPT_MODULE_VERSION,
      intake: "drive",
      fileName: "chosen-transcript.md",
      sourceUrl: "https://drive.google.com/file/d/chosen/view",
      externalId: "chosen-transcript",
    });
    orphan.writeArtifact("transcript.txt", "Richard: This is the chosen transcript.\n");
    orphan.writeArtifact("context.json", '{"meetingDate":null,"attendees":[]}\n');
    orphan.started("extract");

    host.start();

    await vi.waitFor(() => expect(runs.detail(orphan.id)?.status).toBe("skipped"));
    expect(runs.list({ module: TRANSCRIPT_MODULE_ID }).runs).toHaveLength(1);
    expect(
      runs.detail(orphan.id)?.events.find((event) => event.type === "run_recovered")?.detail,
    ).toEqual({
      fromStage: "extract",
      previousStatus: "running",
      reason: "transcript_survived_restart",
    });
  });

  it("delegates retry decisions to its Run engine", async () => {
    const id = await host.startRun({
      intake: "manual",
      fileName: "notes.txt",
      text: "A product specification.",
    });
    await vi.waitFor(() => expect(runs.detail(id)?.status).toBe("skipped"));

    await expect(host.retryRun(id)).rejects.toThrow(/not retryable/i);
  });
});
