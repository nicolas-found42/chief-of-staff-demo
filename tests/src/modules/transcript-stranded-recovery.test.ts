import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { openRuns, type Runs } from "../../../apps/server/src/runs";
import {
  hasSeenForModule,
  rememberSeenForModule,
  reclaimStrandedDriveRun,
} from "../../../apps/server/src/state";
import { TRANSCRIPT_MODULE_ID } from "../../../apps/server/src/modules/transcript/module";

let workspaceDir: string;
let runs: Runs;
let stateFile: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "stranded-"));
  mkdirSync(join(workspaceDir, "runs"), { recursive: true });
  runs = openRuns(workspaceDir);
  stateFile = join(workspaceDir, "state.json");
  writeFileSync(stateFile, "{}\n", "utf8");
});

describe("a Drive Run stranded before convert must not lose the transcript", () => {
  it("releases the ingest checkpoint so the poller re-queues the file", () => {
    // The Drive poller marks the file seen as soon as the Run exists, but the
    // bytes live only in memory until `convert` writes transcript.txt. A restart
    // in between leaves a pending Run that planRecovery can never recover, while
    // the checkpoint stops the poller ever re-queuing it — the transcript is lost.
    const externalId = "drive-file-1";
    const run = runs.create({
      module: TRANSCRIPT_MODULE_ID,
      moduleVersion: 1,
      intake: "drive",
      fileName: "standup.md",
      externalId,
      sourceUrl: "https://drive.google.com/file/d/drive-file-1/view",
    });
    rememberSeenForModule(stateFile, TRANSCRIPT_MODULE_ID, externalId);
    expect(hasSeenForModule(stateFile, TRANSCRIPT_MODULE_ID, externalId)).toBe(true);
    expect(run.read().status).toBe("pending");

    const reclaimed = reclaimStrandedDriveRun({
      runs,
      stateFile,
      moduleId: TRANSCRIPT_MODULE_ID,
      durableFile: "transcript.txt",
    });

    expect(reclaimed).toBe(1);
    // The file is forgotten, so the next poll re-queues it and nothing is lost.
    expect(hasSeenForModule(stateFile, TRANSCRIPT_MODULE_ID, externalId)).toBe(false);
    // And the dead Run is visibly failed rather than pending forever.
    expect(runs.open(run.id)!.read().status).toBe("failed");
  });

  it("leaves a Run that already converted alone, since planRecovery can resume it", () => {
    const externalId = "drive-file-2";
    const run = runs.create({
      module: TRANSCRIPT_MODULE_ID,
      moduleVersion: 1,
      intake: "drive",
      fileName: "standup2.md",
      externalId,
      sourceUrl: "https://drive.google.com/file/d/drive-file-2/view",
    });
    run.writeArtifact("transcript.txt", "already converted\n");
    rememberSeenForModule(stateFile, TRANSCRIPT_MODULE_ID, externalId);

    const reclaimed = reclaimStrandedDriveRun({
      runs,
      stateFile,
      moduleId: TRANSCRIPT_MODULE_ID,
      durableFile: "transcript.txt",
    });

    expect(reclaimed).toBe(0);
    expect(hasSeenForModule(stateFile, TRANSCRIPT_MODULE_ID, externalId)).toBe(true);
    expect(runs.open(run.id)!.read().status).toBe("pending");
  });
});
