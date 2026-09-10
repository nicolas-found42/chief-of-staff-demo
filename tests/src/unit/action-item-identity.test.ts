import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type {
  ActionItem,
  ActionItemProposal,
  MeetingDebriefActionItem,
} from "@chief-of-staff-demo/shared";
import { actionItemProposal, promotable } from "@chief-of-staff-demo/shared";
import { TaskStore } from "../../../apps/server/src/tasks/store";
import { WorkspaceActionItems } from "../../../apps/server/src/tasks/action-items";
import { MaterializationIntegrityError } from "../../../apps/server/src/tasks/materialization";
import { TaskValidationError, WorkspaceTasks } from "../../../apps/server/src/tasks/tasks";
import { promoteActionItem } from "../../../apps/server/src/tasks/promotion";

/**
 * Action Item identity across the stored-format change of issue #355
 * (MWR-008/009/061). A Workspace written before proposal revisions existed
 * must keep every record it already had: the same opaque ids, the same
 * decisions, and its stored proposal readable as the revision promotion
 * accepts.
 */
const roots: string[] = [];
afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

/** A Workspace holding one Action Item in the shape written before #355. */
function legacyWorkspace(overrides: Record<string, unknown> = {}): TaskStore {
  const root = mkdtempSync(join(tmpdir(), "cos-action-item-identity-"));
  roots.push(root);
  mkdirSync(join(root, "tasks"), { recursive: true });
  writeFileSync(
    join(root, "tasks/action-items.json"),
    `${JSON.stringify(
      [
        {
          id: "ai_legacy_1",
          source: {
            debriefRunId: "run_legacy",
            transcriptId: "drive_fileA_r1",
            meetingId: "meeting_1",
          },
          extractionRevision: 1,
          evidence: { responsibleMentionId: "m_alice", responsibleSurfaceName: "Alice" },
          proposal: {
            title: "Follow up on the billing fix",
            notes: "",
            dueDate: "2026-08-22",
            responsiblePerson: null,
          },
          state: "pending",
          promotedTaskId: null,
          createdAt: "2026-09-04T09:00:00.000Z",
          updatedAt: "2026-09-04T09:00:00.000Z",
          decidedAt: null,
          ...overrides,
        },
      ],
      null,
      2,
    )}\n`,
    "utf8",
  );
  return new TaskStore(root);
}

/** The one record the fixture holds, refused rather than narrowed when it is not. */
function only(items: ActionItem[]): ActionItem {
  expect(items).toHaveLength(1);
  return items[0];
}

it("reads a proposal written before revisions existed as the selected revision", () => {
  const item = only(legacyWorkspace().readActionItems());

  expect(item.id).toBe("ai_legacy_1");
  expect(actionItemProposal(item)).toEqual({
    title: "Follow up on the billing fix",
    notes: "",
    dueDate: "2026-08-22",
    responsiblePerson: null,
  });
  expect(item.selectedRevision).toBe(1);
  expect(item.version).toBe(1);
});

it("says honestly that a legacy proposal's extraction artifact is unknown", () => {
  const item = only(legacyWorkspace().readActionItems());

  expect(item.proposalRevisions[0]?.origin.kind).toBe("legacy-import");
  expect(item.observations[0]?.outputEntryId).toBeNull();
  expect(item.observations[0]?.transcriptChecksum).toBeNull();
});

it("keeps a legacy decision rather than reopening it", () => {
  const item = only(
    legacyWorkspace({
      state: "dismissed",
      decidedAt: "2026-09-05T09:00:00.000Z",
    }).readActionItems(),
  );

  expect(item.state).toBe("dismissed");
  expect(item.decidedAt).toBe("2026-09-05T09:00:00.000Z");
  expect(promotable(item)).toBe(false);
});

/** An empty Workspace with the Action Item service over it. */
function workspace(): { root: string; store: TaskStore; actionItems: WorkspaceActionItems } {
  const root = mkdtempSync(join(tmpdir(), "cos-action-item-identity-"));
  roots.push(root);
  const store = new TaskStore(root);
  return { root, store, actionItems: new WorkspaceActionItems({ store }) };
}

function proposed(overrides: Partial<MeetingDebriefActionItem> = {}): MeetingDebriefActionItem {
  return {
    title: "Follow up on the billing fix",
    owner: "Alice",
    ownerMentionId: "m_alice",
    ownerProfileId: null,
    dueDate: "2026-08-22",
    ...overrides,
  };
}

const extraction = (actionItems: MeetingDebriefActionItem[], debriefRunId = "run_1") => ({
  debriefRunId,
  transcriptId: "drive_fileA_r1",
  meetingId: "meeting_1",
  actionItems,
});

const content = (overrides: Partial<ActionItemProposal> = {}): ActionItemProposal => ({
  title: "Follow up on the billing fix",
  notes: "",
  dueDate: "2026-08-22",
  responsiblePerson: null,
  ...overrides,
});

it("keeps two obligations that read identically as two records", () => {
  const { actionItems } = workspace();

  const items = actionItems.materialize(extraction([proposed(), proposed()]));

  expect(items).toHaveLength(2);
  expect(items[0].id).not.toBe(items[1].id);
  expect(
    actionItems.materialize(extraction([proposed(), proposed()])).map((one) => one.id),
  ).toEqual(items.map((one) => one.id));
});

it("refuses a record whose key was allocated for different checked bytes", () => {
  const { store, actionItems } = workspace();
  const [item] = actionItems.materialize(extraction([proposed()]));
  const damaged = store.readActionItems().map((held) => ({
    ...held,
    proposalRevisions: held.proposalRevisions.map((revision) => ({
      ...revision,
      origin: { ...revision.origin, payloadChecksum: `sha256:${"0".repeat(64)}` },
    })),
  }));
  store.writeActionItems(damaged);

  expect(() => actionItems.materialize(extraction([proposed()]))).toThrow(
    MaterializationIntegrityError,
  );
  expect(actionItems.get(item.id)?.id).toBe(item.id);
});

it("holds a corrected proposal unreviewed until the owner selects a revision", () => {
  const { actionItems } = workspace();
  const [item] = actionItems.materialize(extraction([proposed()]));

  const corrected = actionItems.correctProposal(item.id, content({ title: "Corrected wording" }));

  expect(corrected.proposalRevisions).toHaveLength(2);
  expect(actionItemProposal(corrected).title).toBe("Follow up on the billing fix");
  expect(promotable(corrected)).toBe(false);
  expect(actionItems.promotionRefusal(corrected)?.code).toBe("action-item-not-promotable");

  const selected = actionItems.selectProposal(item.id, 2);

  expect(actionItemProposal(selected).title).toBe("Corrected wording");
  expect(promotable(selected)).toBe(true);
  expect(selected.proposalRevisions[0].content.title).toBe("Follow up on the billing fix");
});

it("refuses a command bound to an Action Item version that has moved on", () => {
  const { actionItems } = workspace();
  const [item] = actionItems.materialize(extraction([proposed()]));
  actionItems.correctProposal(item.id, content({ title: "Corrected wording" }));

  expect(() => actionItems.selectProposal(item.id, 2, { expectedVersion: item.version })).toThrow(
    TaskValidationError,
  );
  expect(actionItems.get(item.id)?.selectedRevision).toBe(1);
});

it("makes an owner-linked record non-promotable evidence and refuses to close a cycle", () => {
  const { actionItems } = workspace();
  const [earlier, later] = actionItems.materialize(
    extraction([proposed(), proposed({ title: "Send Bob the rollout plan", owner: "Bob" })]),
  );

  const evidence = actionItems.reconcile(later.id, "evidence-of-historical", {
    targetActionItemId: earlier.id,
  });

  expect(evidence.reconciledInto).toBe(earlier.id);
  expect(promotable(evidence)).toBe(false);
  expect(() =>
    actionItems.reconcile(earlier.id, "evidence-of-historical", {
      targetActionItemId: later.id,
    }),
  ).toThrow(TaskValidationError);
  expect(actionItems.get(earlier.id)?.reconciledInto).toBeNull();
});

it("waits for the owner while a relationship is unresolved and proceeds once it is decided", () => {
  const { actionItems } = workspace();
  const [item] = actionItems.materialize(extraction([proposed()]));

  expect(promotable(actionItems.reconcile(item.id, "unresolved"))).toBe(false);
  expect(promotable(actionItems.reconcile(item.id, "distinct-new-work"))).toBe(true);
});

it("records a repeat of dismissed work as new work without restoring the dismissal", () => {
  const { actionItems } = workspace();
  const [first] = actionItems.materialize(extraction([proposed()]));
  actionItems.dismiss(first.id);

  const [again] = actionItems.materialize(extraction([proposed()], "run_2"));
  const decided = actionItems.reconcile(again.id, "new-commitment");

  expect(again.id).not.toBe(first.id);
  expect(actionItems.get(first.id)?.state).toBe("dismissed");
  expect(promotable(decided)).toBe(true);
});

/** A Workspace with Tasks alongside Action Items, for accepted-work cases. */
function acceptedWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "cos-action-item-identity-"));
  roots.push(root);
  const store = new TaskStore(root);
  const tasks = new WorkspaceTasks({ store });
  const actionItems = new WorkspaceActionItems({ store });
  return { store, tasks, actionItems, deps: { tasks, actionItems } };
}

it("suggests a change to an accepted Task without touching the Task", () => {
  const { tasks, actionItems, deps } = acceptedWorkspace();
  const [item] = actionItems.materialize(extraction([proposed()]));
  const { task } = promoteActionItem(deps, item.id, {});

  const suggested = actionItems.suggestAmendment(item.id, {
    taskId: task.id,
    fields: { dueDate: "2026-09-30" },
    observedTaskVersion: task.version,
  });

  expect(suggested.amendments[0]).toMatchObject({
    taskId: task.id,
    fields: { dueDate: "2026-09-30" },
    status: "suggested",
  });
  expect(tasks.get(task.id)).toEqual(task);
});

it("records an amendment as applied only after the owner's own Task edit", () => {
  const { tasks, actionItems, deps } = acceptedWorkspace();
  const [item] = actionItems.materialize(extraction([proposed()]));
  const { task } = promoteActionItem(deps, item.id, {});
  const amendmentId = actionItems.suggestAmendment(item.id, {
    taskId: task.id,
    fields: { dueDate: "2026-09-30" },
    observedTaskVersion: task.version,
  }).amendments[0].id;

  const edited = tasks.update(
    task.id,
    { dueDate: "2026-09-30" },
    { expectedVersion: task.version },
  );
  const resolved = actionItems.resolveAmendment(amendmentId, "applied", {
    taskVersion: edited.version,
  });

  expect(edited.version).toBe(task.version + 1);
  expect(resolved.amendments[0].status).toBe("applied");
  expect(resolved.amendments[0].observedTaskVersion).toBe(task.version);
});

it("refuses a Task edit bound to a version the Task has moved past", () => {
  const { tasks, actionItems, deps } = acceptedWorkspace();
  const [item] = actionItems.materialize(extraction([proposed()]));
  const { task } = promoteActionItem(deps, item.id, {});
  tasks.update(task.id, { title: "Owner's own wording" }, { expectedVersion: task.version });

  expect(() =>
    tasks.update(task.id, { title: "Stale writer" }, { expectedVersion: task.version }),
  ).toThrow(TaskValidationError);
  expect(tasks.get(task.id)?.title).toBe("Owner's own wording");
});

it("leaves accepted work exactly as the owner left it when the proposal is corrected", () => {
  const { tasks, actionItems, deps } = acceptedWorkspace();
  const [item] = actionItems.materialize(extraction([proposed()]));
  const { task } = promoteActionItem(deps, item.id, { title: "Accepted wording" });
  const completed = tasks.complete(task.id);

  actionItems.correctProposal(item.id, content({ title: "Later paraphrase" }));

  expect(tasks.get(task.id)).toEqual(completed);
  expect(actionItems.get(item.id)?.state).toBe("promoted");
  expect(actionItems.get(item.id)?.promotedTaskId).toBe(task.id);
});

it("refuses to promote a record that is evidence about earlier work", () => {
  const { actionItems, deps } = acceptedWorkspace();
  const [earlier, later] = actionItems.materialize(
    extraction([proposed(), proposed({ title: "Send Bob the rollout plan", owner: "Bob" })]),
  );
  actionItems.reconcile(later.id, "evidence-of-historical", { targetActionItemId: earlier.id });

  expect(() => promoteActionItem(deps, later.id, {})).toThrow(TaskValidationError);
});

it("allocates no second record when a materialization was interrupted after its records were committed", () => {
  const { root, actionItems } = workspace();
  const [first] = actionItems.materialize(extraction([proposed()]));
  /* The crash interval: the records reached the Workspace and whatever index
     accompanies them did not. A replay must find the obligation it already
     allocated rather than proposing it a second time. */
  rmSync(join(root, "tasks/action-item-mappings.json"), { force: true });

  const replayed = actionItems.materialize(extraction([proposed()]));
  const again = actionItems.materialize(extraction([proposed()]));

  expect(replayed.map((one) => one.id)).toEqual([first.id]);
  expect(again.map((one) => one.id)).toEqual([first.id]);
  expect(actionItems.list()).toHaveLength(1);
});

it("keeps a legacy promoted decision and its Task relationship", () => {
  const item = only(
    legacyWorkspace({
      state: "promoted",
      promotedTaskId: "task_legacy_1",
      decidedAt: "2026-09-05T09:00:00.000Z",
    }).readActionItems(),
  );

  expect(item.state).toBe("promoted");
  expect(item.promotedTaskId).toBe("task_legacy_1");
  expect(item.decidedAt).toBe("2026-09-05T09:00:00.000Z");
  expect(promotable(item)).toBe(false);
  expect(item.amendments).toEqual([]);
});

it("reads a Task written before versions existed as the first version", () => {
  const root = mkdtempSync(join(tmpdir(), "cos-action-item-identity-"));
  roots.push(root);
  mkdirSync(join(root, "tasks"), { recursive: true });
  writeFileSync(
    join(root, "tasks/tasks.json"),
    `${JSON.stringify(
      [
        {
          id: "task_legacy_1",
          title: "Accepted before versions",
          notes: "",
          status: "open",
          dueDate: null,
          priority: "none",
          listId: "inbox",
          responsiblePerson: { kind: "owner" },
          destination: { provider: "local" },
          source: null,
          createdAt: "2026-09-04T09:00:00.000Z",
          updatedAt: "2026-09-04T09:00:00.000Z",
          completedAt: null,
        },
      ],
      null,
      2,
    )}\n`,
    "utf8",
  );

  const tasks = new TaskStore(root).readTasks();

  expect(tasks).toHaveLength(1);
  expect(tasks[0].id).toBe("task_legacy_1");
  expect(tasks[0].version).toBe(1);
  expect(tasks[0].deletedAt).toBeNull();
});
