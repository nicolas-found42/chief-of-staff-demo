import {
  statSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaskCutover } from "../../../apps/server/src/tasks/cutover";
import { TaskStore } from "../../../apps/server/src/tasks/store";
import { composeShell, type Shell } from "../../../apps/server/src/composition/shell";

const directories: string[] = [];

const originalProviderEnvironment = {
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
};

function clearProviderEnvironment(): void {
  for (const name of Object.keys(originalProviderEnvironment)) {
    process.env[name] = "";
  }
}

function restoreProviderEnvironment(): void {
  for (const [name, value] of Object.entries(originalProviderEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

beforeEach(() => {
  clearProviderEnvironment();
});
const shells: Shell[] = [];
function workspace() {
  const dir = mkdtempSync(join(tmpdir(), "found42-pristine-"));
  directories.push(dir);
  return dir;
}
afterEach(async () => {
  for (const shell of shells.splice(0)) {
    shell.stop();
    await shell.app.close();
  }
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

afterEach(async () => {
  restoreProviderEnvironment();
});

describe("pristine production initialization", () => {
  it("publishes one empty canonical bundle before normal boot and stays initialized across concurrent composition and restart", async () => {
    const dir = workspace();
    const pair = await Promise.all([
      composeShell({ workspaceDir: dir, port: 4998 }),
      composeShell({ workspaceDir: dir, port: 4998 }),
    ]);
    shells.push(...pair);
    const store = new TaskStore(dir);
    expect(store.cutoverReceipt()?.counts).toEqual({
      legacyRuns: 0,
      receipts: 0,
      tasks: 0,
      actionItems: 0,
      taskLists: 0,
      tasksToCreate: 0,
      actionItemsToCreate: 0,
    });
    const initial = readFileSync(join(dir, "tasks/state.json"), "utf8");
    for (const shell of pair) {
      expect(shell.gate.isActive()).toBe(false);
      const status = (await shell.app.inject("/api/migration/status")).json();
      expect(status).toMatchObject({ state: "completed", origin: "pristine" });
      expect(status.onboarding.complete).toBe(false);
      expect((await shell.app.inject("/api/onboarding/owner")).json().confirmed).toBeNull();
    }
    const restarted = await composeShell({ workspaceDir: dir, port: 4998 });
    shells.push(restarted);
    expect(restarted.gate.isActive()).toBe(false);
    expect(readFileSync(join(dir, "tasks/state.json"), "utf8")).toBe(initial);
    expect(store.readTasks()).toEqual([]);
  });

  it("starts a credential-less production Workspace with setup waits and no dependent Runs", async () => {
    const dir = workspace();
    const shell = await composeShell({ workspaceDir: dir, port: 4998 });
    shells.push(shell);
    await shell.start();
    await Promise.all(shell.modules.map((module) => module.idle?.() ?? Promise.resolve()));
    expect(shell.workspace.runs.list({ module: "content-research" }).runs).toEqual([]);
    const index = (await shell.app.inject("/api/content-research/index")).json();
    expect(index.waiting.research).toMatch(/provider|API key/);
    expect(index.waiting.discovery).toMatch(/provider|API key/);
    const rejected = await shell.app.inject({
      method: "POST",
      url: "/api/content-research/run",
    });
    expect(rejected.statusCode).toBe(409);
    expect(shell.workspace.runs.list({ module: "content-research" }).runs).toEqual([]);
  });

  it("requires owner confirmation after provider setup and preserves independent discovery prerequisites", async () => {
    const dir = workspace();
    const shell = await composeShell({ workspaceDir: dir, port: 4998 });
    shells.push(shell);
    const waiting = async () =>
      (await shell.app.inject("/api/content-research/index")).json<{
        waiting: { research: string | null; discovery: string | null };
      }>().waiting;
    process.env.OPENROUTER_API_KEY = "synthetic-not-a-live-key";
    shell.workspace.config.update({ provider: "openrouter" });
    expect((await waiting()).research).toContain("Confirm the owner");
    const person = shell.workspace.profiles.create({
      fullName: "Synthetic Owner",
      primaryEmail: "owner@example.test",
    });
    shell.workspace.onboarding.setConnectedIdentity("owner@example.test");
    shell.workspace.onboarding.confirm(person.id);
    expect((await waiting()).research).toBeNull();
    expect((await waiting()).discovery).toContain("Brand Voice");
    shell.workspace.config.update({ model: "synthetic-model" });
    expect((await waiting()).research).toBeNull();
    process.env.OPENROUTER_API_KEY = "";
    expect((await waiting()).research).toContain("Guided Setup");
    process.env.OPENROUTER_API_KEY = "synthetic-not-a-live-key";
    shell.workspace.onboarding.setConnectedIdentity(null);
    expect((await waiting()).research).toContain("Confirm the owner");
    expect(shell.workspace.runs.list().runs).toEqual([]);
  });

  it("recognizes the production entrypoint's empty lock inode without changing it", () => {
    const dir = workspace();
    const lock = join(dir, ".writer.lock");
    writeFileSync(lock, "");
    const inode = statSync(lock).ino;
    expect(new TaskCutover({ workspaceDir: dir }).initializePristine()).toBe(true);
    expect(statSync(lock).ino).toBe(inode);
    expect(readFileSync(lock, "utf8")).toBe("");
  });

  it.each([
    ".writer.lock",
    "config.json",
    "unexpected",
    "migration/receipt.json",
    "tasks/.state.json.123.abcdef.tmp",
  ])("preserves existing or interrupted %s even with no Task preview counts", async (entry) => {
    const dir = workspace();
    if (entry.includes("/")) mkdirSync(join(dir, entry.split("/")[0]), { recursive: true });
    writeFileSync(join(dir, entry), "{}");
    const cutover = new TaskCutover({ workspaceDir: dir });
    expect(cutover.initializePristine()).toBe(false);
    expect(cutover.state()).toBe("required");
    expect(readFileSync(join(dir, entry), "utf8")).toBe("{}");
    expect(cutover.receipt()).toBeNull();
    expect((await cutover.preview()).counts.tasks).toBe(0);
  });

  it("keeps an interrupted publication intact until explicit recovery, then repeated entry is harmless", async () => {
    const dir = workspace();
    mkdirSync(join(dir, "tasks"));
    writeFileSync(join(dir, "tasks/.state.json.123.abcdef.tmp"), "partial");
    const cutover = new TaskCutover({ workspaceDir: dir });
    expect(cutover.initializePristine()).toBe(false);
    const preview = await cutover.preview();
    await cutover.execute({ ...preview, typedConfirmation: "MIGRATE TASKS" });
    expect(cutover.initializePristine()).toBe(true);
    expect(readFileSync(join(dir, "tasks/.state.json.123.abcdef.tmp"), "utf8")).toBe("partial");
    expect(readdirSync(join(dir, "tasks"))).toHaveLength(2);
  });
});
