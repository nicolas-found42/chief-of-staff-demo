import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { WorkspaceBackup } from "../../../apps/server/src/backup/workspace";
import { TaskStore } from "../../../apps/server/src/tasks/store";
import { WorkspaceTasks } from "../../../apps/server/src/tasks/tasks";
import { WorkspaceActionItems } from "../../../apps/server/src/tasks/action-items";
import { promoteActionItem } from "../../../apps/server/src/tasks/promotion";
import { registerTasksApi } from "../../../apps/server/src/api/tasks";
import fastify from "fastify";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

it.each(["ENOSPC", "EACCES"])(
  "a %s error after copied bytes cannot publish a restore",
  async (code) => {
    const root = mkdtempSync(join(tmpdir(), "workspace-backup-io-"));
    roots.push(root);
    const workspace = join(root, "source");
    const source = new TaskStore(workspace);
    new WorkspaceTasks({ store: source }).create({ title: "Accepted work survives I/O refusal" });
    const expected = source.readTasks();
    const backup = new WorkspaceBackup(workspace, async () => {});
    const saved = join(root, "backup");
    await backup.capture(saved);
    const copy = fs.cp;
    const failure = vi.spyOn(fs, "cp").mockImplementationOnce(async (...args) => {
      await copy(...args);
      throw Object.assign(new Error(code), { code });
    });
    try {
      await expect(backup.restore(saved, join(root, "failed"))).rejects.toThrow(code);
      expect(existsSync(join(root, "failed"))).toBe(false);
      expect(source.readTasks()).toEqual(expected);
    } finally {
      failure.mockRestore();
    }
    for (const name of ["one", "two"]) {
      await backup.restore(saved, join(root, name));
      expect(new TaskStore(join(root, name)).readTasks()).toEqual(expected);
    }
  },
);

it("restored application reads preserve accepted snapshots, dismissal and deletion history", async () => {
  const root = mkdtempSync(join(tmpdir(), "workspace-backup-history-"));
  roots.push(root);
  const workspace = join(root, "source");
  const store = new TaskStore(workspace);
  const tasks = new WorkspaceTasks({ store });
  const actionItems = new WorkspaceActionItems({ store });
  const items = actionItems.materialize({
    debriefRunId: "run",
    transcriptId: "transcript",
    meetingId: "meeting",
    actionItems: ["Accepted proposal", "Dismissed proposal", "Deleted accepted proposal"].map(
      (title) => ({
        title,
        owner: null,
        ownerMentionId: null,
        ownerProfileId: null,
        dueDate: null,
      }),
    ),
  });
  const original = promoteActionItem({ tasks, actionItems }, items[0].id, {
    title: "Original accepted title",
  }).task;
  tasks.update(original.id, { title: "Later owner edit" });
  tasks.complete(original.id);
  actionItems.dismiss(items[1].id);
  const deleted = promoteActionItem({ tasks, actionItems }, items[2].id).task;
  tasks.trash(deleted.id);
  tasks.deleteForever(deleted.id, { confirmed: true });
  const expected = { tasks: store.readTasks(), actionItems: store.readActionItems() };
  const backup = new WorkspaceBackup(workspace, async () => {});
  await backup.capture(join(root, "backup"));
  for (const name of ["one", "two"]) {
    const restored = join(root, name);
    await backup.restore(join(root, "backup"), restored);
    const restoredStore = new TaskStore(restored);
    const app = fastify();
    registerTasksApi(app, {
      tasks: new WorkspaceTasks({ store: restoredStore }),
      actionItems: new WorkspaceActionItems({ store: restoredStore }),
    });
    try {
      const response = await app.inject({ method: "GET", url: "/api/tasks?status=completed" });
      expect(response.statusCode).toBe(200);
      expect(response.json().tasks).toEqual(expected.tasks);
      expect(restoredStore.readActionItems()).toEqual(expected.actionItems);
      expect(restoredStore.readTasks()[0].source).toEqual(original.source);
      const retry = await app.inject({
        method: "POST",
        url: `/api/action-items/${items[2].id}/promote`,
        payload: {},
      });
      expect(retry.statusCode).toBe(404);
      expect(retry.json()).toMatchObject({ error: "task-not-found" });
      expect(restoredStore.readTasks()).toEqual(expected.tasks);
    } finally {
      await app.close();
    }
  }
});

it("restores edited, completed and trashed Tasks twice without changing accepted IDs or current content", async () => {
  const root = mkdtempSync(join(tmpdir(), "workspace-backup-"));
  roots.push(root);
  const workspace = join(root, "source");
  const tasks = new WorkspaceTasks({ store: new TaskStore(workspace) });
  const first = tasks.create({ title: "Accepted work" });
  tasks.update(first.id, { title: "Owner edited work" });
  tasks.complete(first.id);
  const second = tasks.create({ title: "Work in Trash" });
  tasks.trash(second.id);
  const expected = new TaskStore(workspace).readTasks();
  // This isolated synthetic Workspace has no process, scheduler or network writer.
  const backup = new WorkspaceBackup(workspace, async () => {});
  const receipt = await backup.capture(join(root, "backup"));
  expect(receipt.fileCount).toBeGreaterThan(0);
  for (const name of ["restored-1", "restored-2"]) {
    const restored = join(root, name);
    await backup.restore(join(root, "backup"), restored);
    expect(statSync(restored).mode & 0o777).toBe(0o700);
    expect(new TaskStore(restored).readTasks()).toEqual(expected);
    expect(new TaskStore(restored).readLists()).toEqual(new TaskStore(workspace).readLists());
  }
  expect(new TaskStore(workspace).readTasks()).toEqual(expected);
});

it("refuses a capture when a source changes during copying and never publishes it", async () => {
  const root = mkdtempSync(join(tmpdir(), "workspace-backup-change-"));
  roots.push(root);
  const workspace = join(root, "source");
  const tasks = new WorkspaceTasks({ store: new TaskStore(workspace) });
  tasks.create({ title: "Original" });
  let checks = 0;
  const backup = new WorkspaceBackup(workspace, async () => {
    if (++checks === 2) tasks.create({ title: "Concurrent owner work" });
  });
  await expect(backup.capture(join(root, "backup"))).rejects.toThrow("inventory changed");
  expect(existsSync(join(root, "backup"))).toBe(false);
  expect(new TaskStore(workspace).readTasks()).toHaveLength(2);
});

it("refuses an existing destination without replacing an earlier backup", async () => {
  const root = mkdtempSync(join(tmpdir(), "workspace-backup-existing-"));
  roots.push(root);
  const workspace = join(root, "source");
  new WorkspaceTasks({ store: new TaskStore(workspace) }).create({ title: "Original" });
  const backup = new WorkspaceBackup(workspace, async () => {});
  const destination = join(root, "backup");
  await backup.capture(destination);
  await expect(backup.capture(destination)).rejects.toThrow("destination already exists");
  expect(existsSync(`${destination}.partial`)).toBe(false);
  writeFileSync(join(workspace, "new-intent.json"), "{}");
  await expect(backup.restore(destination, join(root, "restored"))).rejects.toThrow(
    "inventory changed",
  );
  expect(existsSync(join(root, "restored"))).toBe(false);
});

it("rejects nested destinations before writing into the source", async () => {
  const root = mkdtempSync(join(tmpdir(), "workspace-backup-nested-"));
  roots.push(root);
  const workspace = join(root, "source");
  mkdirSync(workspace);
  const backup = new WorkspaceBackup(workspace, async () => {});
  await expect(backup.capture(join(workspace, "backup"))).rejects.toThrow("overlap");
  expect(existsSync(join(workspace, "backup.partial"))).toBe(false);
});

it.each(["truncate", "missing", "stale-version", "missing-current-ledger"])(
  "refuses %s restoration without exposing any records",
  async (fault) => {
    const root = mkdtempSync(join(tmpdir(), "workspace-backup-corrupt-"));
    roots.push(root);
    const workspace = join(root, "source");
    new WorkspaceTasks({ store: new TaskStore(workspace) }).create({ title: "Preserved work" });
    writeFileSync(join(workspace, "deletion-ledger.json"), '{"deleted":["synthetic-source"]}');
    const backup = new WorkspaceBackup(workspace, async () => {});
    const saved = join(root, "backup");
    await backup.capture(saved);
    if (fault === "truncate") writeFileSync(join(saved, "workspace/tasks/tasks.json"), "[");
    if (fault === "missing") rmSync(join(saved, "workspace/tasks/tasks.json"));
    if (fault === "missing-current-ledger") rmSync(join(workspace, "deletion-ledger.json"));
    if (fault === "stale-version") {
      const manifest = join(saved, "manifest.json");
      writeFileSync(manifest, readFileSync(manifest, "utf8").replace('"version":1', '"version":0'));
    }
    await expect(backup.restore(saved, join(root, "restored"))).rejects.toThrow();
    expect(existsSync(join(root, "restored"))).toBe(false);
    expect(new TaskStore(workspace).readTasks()[0].title).toBe("Preserved work");
  },
);

it("keeps an interrupted capture unaccepted and permits a fresh attempt", async () => {
  const root = mkdtempSync(join(tmpdir(), "workspace-backup-interrupted-"));
  roots.push(root);
  const workspace = join(root, "source");
  new WorkspaceTasks({ store: new TaskStore(workspace) }).create({ title: "Preserved work" });
  let checks = 0;
  const interrupted = new WorkspaceBackup(workspace, async () => {
    if (++checks === 2) throw new Error("Writer appeared");
  });
  await expect(interrupted.capture(join(root, "interrupted"))).rejects.toThrow("Writer appeared");
  expect(existsSync(join(root, "interrupted/manifest.json"))).toBe(false);
  const recovered = new WorkspaceBackup(workspace, async () => {});
  await expect(
    recovered.restore(join(root, "interrupted.partial"), join(root, "unsafe")),
  ).rejects.toThrow();
  await recovered.capture(join(root, "recovered"));
  for (const name of ["one", "two"]) {
    await recovered.restore(join(root, "recovered"), join(root, name));
    expect(new TaskStore(join(root, name)).readTasks()[0].title).toBe("Preserved work");
  }
});

it.each(["before", "after"])(
  "survives process termination %s capture publication and recovers twice",
  async (boundary) => {
    const root = mkdtempSync(join(tmpdir(), "workspace-backup-kill-"));
    roots.push(root);
    const workspace = join(root, "source");
    const tasks = new WorkspaceTasks({ store: new TaskStore(workspace) });
    const task = tasks.create({ title: "Accepted before process termination" });
    tasks.complete(task.id);
    const expected = new TaskStore(workspace).readTasks();
    const destination = join(root, "killed");
    const worker = join(root, "worker.mts");
    writeFileSync(
      worker,
      `import { promises as fs } from 'node:fs';
import { WorkspaceBackup } from ${JSON.stringify(new URL("../../../apps/server/src/backup/workspace.ts", import.meta.url).href)};
const original = fs.rename;
fs.rename = async (...args) => {
  if (${JSON.stringify(boundary)} === 'before') process.kill(process.pid, 'SIGKILL');
  const result = await original(...args);
  if (${JSON.stringify(boundary)} === 'after') process.kill(process.pid, 'SIGKILL');
  return result;
};
await new WorkspaceBackup(${JSON.stringify(workspace)}, async () => {}).capture(${JSON.stringify(destination)});
`,
    );
    const killed = spawnSync(process.execPath, ["--import", "tsx", worker], { encoding: "utf8" });
    expect(killed.signal).toBe("SIGKILL");
    expect(new TaskStore(workspace).readTasks()).toEqual(expected);
    const backup = new WorkspaceBackup(workspace, async () => {});
    const accepted = boundary === "after" ? destination : join(root, "fresh");
    if (boundary === "before") {
      expect(existsSync(destination)).toBe(false);
      await expect(backup.restore(`${destination}.partial`, join(root, "unsafe"))).rejects.toThrow(
        "partial",
      );
      await backup.capture(accepted);
    }
    for (const name of ["one", "two"]) {
      await backup.restore(accepted, join(root, name));
      expect(new TaskStore(join(root, name)).readTasks()).toEqual(expected);
    }
  },
);
