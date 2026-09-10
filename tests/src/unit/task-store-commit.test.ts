import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { TaskStore, TaskStoreFormatError } from "../../../apps/server/src/tasks/store";
import { WorkspaceTasks } from "../../../apps/server/src/tasks/tasks";
import type { TaskCutoverReceipt } from "@chief-of-staff-demo/shared";

const roots: string[] = [];
afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

function scratchWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), "cos-task-store-"));
  roots.push(root);
  return root;
}

const bundleOf = (workspace: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(workspace, "tasks/state.json"), "utf8")) as Record<string, unknown>;

/** A cutover receipt that tells the truth about an empty synthetic migration. */
function syntheticReceipt(workspace: string): TaskCutoverReceipt {
  return {
    kind: "canonical-tasks",
    workspace,
    fingerprint: "0".repeat(64),
    counts: {
      legacyRuns: 0,
      receipts: 0,
      tasks: 0,
      actionItems: 0,
      taskLists: 0,
      tasksToCreate: 0,
      actionItemsToCreate: 0,
    },
    authenticationPreserved: true,
    historicalRunsPreserved: true,
    completedAt: "2026-09-10T00:00:00.000Z",
  };
}

/** Publish the canonical bundle the way the migration flow does, then hand back the store. */
function canonicalWorkspace(): { workspace: string; store: TaskStore } {
  const workspace = scratchWorkspace();
  const store = new TaskStore(workspace);
  store.publishCutover({ tasks: [], lists: [], actionItems: [] }, syntheticReceipt(workspace));
  return { workspace, store };
}

it("stamps the canonical bundle with its format and a generation each write advances", () => {
  const { workspace, store } = canonicalWorkspace();
  new WorkspaceTasks({ store }).create({ title: "First" });

  const first = bundleOf(workspace);
  expect(first.format).toBe(2);
  expect(first.generation).toBe(2);
  expect(store.readGeneration()).toBe(2);

  new WorkspaceTasks({ store }).create({ title: "Second" });
  expect(bundleOf(workspace).generation).toBe(3);
  expect(store.readTasks().map((task) => task.title)).toEqual(["First", "Second"]);
});

it("readers accept a bundle written before the format existed", () => {
  const { workspace, store } = canonicalWorkspace();
  new WorkspaceTasks({ store }).create({ title: "Carried forward" });
  const current = bundleOf(workspace);
  delete current.format;
  delete current.generation;
  writeFileSync(join(workspace, "tasks/state.json"), JSON.stringify(current, null, 2));

  expect(store.readGeneration()).toBe(0);
  expect(store.readTasks().map((task) => task.title)).toEqual(["Carried forward"]);

  new WorkspaceTasks({ store }).create({ title: "Stamped" });
  expect(bundleOf(workspace).format).toBe(2);
  expect(bundleOf(workspace).generation).toBe(1);
});

it("refuses a bundle from a later build instead of rewriting it", () => {
  const { workspace, store } = canonicalWorkspace();
  new WorkspaceTasks({ store }).create({ title: "Preserved" });
  const future = { ...bundleOf(workspace), format: 99, generation: 40 };
  writeFileSync(join(workspace, "tasks/state.json"), JSON.stringify(future, null, 2));

  expect(() => store.readTasks()).toThrow(TaskStoreFormatError);
  expect(() => new WorkspaceTasks({ store }).create({ title: "Refused" })).toThrow(
    TaskStoreFormatError,
  );
  // The later build's file is exactly as it was left.
  expect(bundleOf(workspace)).toEqual(future);
});

it.each([
  { format: "2" },
  { format: 0 },
  { format: 1.5 },
  { generation: "3" },
  { generation: -1 },
  { generation: 1.5 },
])("refuses malformed version metadata %j without replacing the bundle", (metadata) => {
  const { workspace, store } = canonicalWorkspace();
  const damaged = { ...bundleOf(workspace), ...metadata };
  const bytes = JSON.stringify(damaged);
  writeFileSync(join(workspace, "tasks/state.json"), bytes);
  expect(() => new WorkspaceTasks({ store }).create({ title: "Refused" })).toThrow();
  expect(readFileSync(join(workspace, "tasks/state.json"), "utf8")).toBe(bytes);
});

it("refuses to publish when the records directory cannot be written", () => {
  const { workspace, store } = canonicalWorkspace();
  const tasks = new WorkspaceTasks({ store });
  tasks.create({ title: "Committed first" });
  const before = bundleOf(workspace);
  const tasksDir = join(workspace, "tasks");
  chmodSync(tasksDir, 0o500);
  try {
    expect(() => tasks.create({ title: "Refused" })).toThrow(/EACCES|EPERM/);
  } finally {
    chmodSync(tasksDir, 0o700);
  }

  // The refused attempt left the committed record authoritative, with no
  // half-written temporary left where a reader would walk.
  expect(bundleOf(workspace)).toEqual(before);
  expect(store.readGeneration()).toBe(2);
  expect(store.readTasks().map((task) => task.title)).toEqual(["Committed first"]);
  expect(readdirSync(tasksDir)).toEqual(["state.json"]);
});

it("keeps a legacy per-file workspace readable and written the way it was", () => {
  const workspace = scratchWorkspace();
  const store = new TaskStore(workspace);
  const tasks = new WorkspaceTasks({ store });
  tasks.create({ title: "Legacy shape" });

  expect(store.readGeneration()).toBe(0);
  expect(readFileSync(join(workspace, "tasks/tasks.json"), "utf8")).toContain("Legacy shape");
  expect(store.readTasks()).toHaveLength(1);
});

it("keeps the cutover receipt and continues the generation when records change", () => {
  const workspace = scratchWorkspace();
  const store = new TaskStore(workspace);
  const receipt = syntheticReceipt(workspace);
  new WorkspaceTasks({ store }).create({ title: "Migrated" });
  store.publishCutover(
    {
      tasks: store.readTasks(),
      lists: store.readLists(),
      actionItems: store.readActionItems(),
    },
    receipt,
  );
  expect(store.readGeneration()).toBe(1);
  expect(store.cutoverReceipt()).toEqual(receipt);

  new WorkspaceTasks({ store }).create({ title: "After migration" });
  expect(store.readGeneration()).toBe(2);
  expect(store.cutoverReceipt()).toEqual(receipt);
  expect(store.readTasks()).toHaveLength(2);
});
