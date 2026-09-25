import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fromPartial } from "@total-typescript/shoehorn";
import { afterEach, describe, expect, it } from "vitest";
import { ContentResearchHost } from "../../../apps/server/src/modules/content-research/host";
import { ConfigStore } from "../../../apps/server/src/config";
import { openRuns } from "../../../apps/server/src/runs";
import {
  CONTENT_RESEARCH_BACKFILL_INTAKE,
  CONTENT_RESEARCH_DISCOVERY_INTAKE,
  CONTENT_RESEARCH_INTAKE,
} from "../../../apps/server/src/modules/content-research/module";

const directories: string[] = [];
const hosts: ContentResearchHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) {
    host.stop();
    await host.idle();
  }
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "found42-prerequisites-"));
  directories.push(dir);
  const runs = openRuns(dir);
  const configStore = new ConfigStore(join(dir, "config.json"));
  configStore.load();
  let waiting: string | null = "Configure provider and confirm owner.";
  const host = new ContentResearchHost({
    workspaceDir: dir,
    runs,
    configStore,
    adapters: [],
    profileProjection: () => fromPartial({ purpose: "public-safe", fullName: "Synthetic Person" }),
    now: () => new Date("2026-09-14T20:00:00Z"),
    hookExtractor: {
      async extract() {
        throw new Error("No collection expected");
      },
    },
    discoverer: {
      async discover() {
        return [];
      },
    },
    searchPublic: async () => [],
    readiness: () => waiting,
  });
  hosts.push(host);
  return {
    dir,
    runs,
    host,
    ready: () => {
      waiting = null;
    },
    disconnect: () => {
      waiting = "Reconnect provider.";
    },
  };
}

describe("Content Research setup admission", () => {
  it("refuses manual and scheduled dependent work before Run creation", async () => {
    const f = fixture();
    await expect(f.host.researchNow()).rejects.toThrow("Configure provider and confirm owner");
    await expect(f.host.backfillNow(30)).rejects.toThrow("Configure provider and confirm owner");
    await expect(f.host.discoverNow()).rejects.toThrow("Configure provider and confirm owner");
    f.host.addPerson({ profileId: "synthetic-person" });
    await f.host.checkSchedules();
    expect(f.runs.list().runs).toEqual([]);
    expect(f.host.getIndex().waiting?.research).toContain("Configure provider");
  });

  it("admits each due schedule once after setup completes", async () => {
    const f = fixture();
    f.host.addPerson({ profileId: "synthetic-person" });
    await f.host.checkSchedules();
    expect(f.runs.list().runs).toEqual([]);
    f.ready();
    await Promise.all([f.host.checkSchedules(), f.host.checkSchedules()]);
    await f.host.idle();
    await f.host.checkSchedules();
    expect(
      f.runs
        .list()
        .runs.map((run) => run.intake)
        .sort(),
    ).toEqual([CONTENT_RESEARCH_INTAKE, CONTENT_RESEARCH_DISCOVERY_INTAKE].sort());
    f.disconnect();
    await f.host.checkSchedules();
    expect(f.runs.list().runs).toHaveLength(2);
  });

  it.each([
    CONTENT_RESEARCH_INTAKE,
    CONTENT_RESEARCH_BACKFILL_INTAKE,
    CONTENT_RESEARCH_DISCOVERY_INTAKE,
  ])(
    "retains pending %s during setup, recovers once after setup, and honors later disconnect",
    async (intake) => {
      const f = fixture();
      const run = f.runs.create({
        module: "content-research",
        moduleVersion: 1,
        intake,
        sourceUrl: null,
        externalId: intake === CONTENT_RESEARCH_BACKFILL_INTAKE ? "backfill:30" : null,
      });
      f.host.start();
      await f.host.idle();
      expect(run.read().status).toBe("pending");
      f.ready();
      f.host.start();
      await f.host.idle();
      expect(run.read().status).toBe("done");
      f.host.start();
      await f.host.idle();
      expect(f.runs.list().runs).toHaveLength(1);
      f.disconnect();
      await expect(f.host.discoverNow()).rejects.toThrow("Reconnect provider");
      expect(f.runs.list().runs).toHaveLength(1);
    },
  );

  it.each([
    { intake: CONTENT_RESEARCH_BACKFILL_INTAKE, stage: "collect", externalId: "backfill:30" },
    { intake: CONTENT_RESEARCH_DISCOVERY_INTAKE, stage: "discover", externalId: null },
  ])(
    "recovers persisted running $intake through its owning intake after restart",
    async ({ intake, stage, externalId }) => {
      const f = fixture();
      const run = f.runs.create({
        module: "content-research",
        moduleVersion: 1,
        intake,
        sourceUrl: null,
        externalId,
      });
      run.started(stage);
      f.ready();
      f.host.start();
      await f.host.idle();
      const detail = openRuns(f.dir).detail(run.id);
      expect(detail?.status).toBe("done");
      expect(detail?.events.filter((event) => event.type === "run_recovered")).toMatchObject([
        { detail: { previousStatus: "running", fromStage: stage } },
      ]);
      f.host.stop();
      f.host.start();
      await f.host.idle();
      expect(
        openRuns(f.dir)
          .detail(run.id)
          ?.events.filter((event) => event.type === "run_recovered"),
      ).toHaveLength(1);
    },
  );

  it("rechecks queued execution before provider work and recovers the pending intent", async () => {
    const f = fixture();
    f.ready();
    const admitted = f.host.backfillNow(7);
    f.disconnect();
    const id = await admitted;
    await f.host.idle();
    expect(f.runs.open(id)?.read().status).toBe("pending");
    f.ready();
    f.host.start();
    await f.host.idle();
    expect(f.runs.open(id)?.read().status).toBe("done");
    expect(f.runs.list().runs).toHaveLength(1);
  });
});
