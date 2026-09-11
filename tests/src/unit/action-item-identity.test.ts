import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type {
  ActionItem,
  ActionItemProposal,
  MeetingDebriefActionItem,
  MeetingHandoff,
  MeetingHandoffRecord,
} from "@chief-of-staff-demo/shared";
import { actionItemProposal, currentReconciliation, promotable } from "@chief-of-staff-demo/shared";
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

/** Put the Workspace on the canonical bundle, the way the cutover does. */
function publishCanonical(store: TaskStore): void {
  store.publishCutover(
    { tasks: store.readTasks(), lists: [], actionItems: store.readActionItems() },
    {
      kind: "canonical-tasks",
      workspace: "isolated",
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
    },
  );
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

it("keeps every reconciliation the owner recorded, not only the latest", () => {
  const { actionItems } = workspace();
  const [item] = actionItems.materialize(extraction([proposed()]));

  actionItems.reconcile(item.id, "distinct-new-work");
  const after = actionItems.reconcile(item.id, "new-commitment");

  expect(after.reconciliations.map((one) => one.disposition)).toEqual([
    "distinct-new-work",
    "new-commitment",
  ]);
  expect(currentReconciliation(after)?.disposition).toBe("new-commitment");
});

it("records attaching evidence as what it was", () => {
  const { actionItems } = workspace();
  const [earlier, later] = actionItems.materialize(
    extraction([proposed(), proposed({ title: "Send Bob the rollout plan", owner: "Bob" })]),
  );

  const evidence = actionItems.reconcile(later.id, "evidence-of-historical", {
    targetActionItemId: earlier.id,
  });

  expect(evidence.decisions.map((one) => one.kind)).toEqual(["attach-evidence"]);
  expect(evidence.decisions[0].versions.actionItemVersion).toBe(evidence.version);
});

it("writes the decision history a review surface reads back", () => {
  const { actionItems, deps } = acceptedWorkspace();
  const [item] = actionItems.materialize(extraction([proposed()]));
  actionItems.correctProposal(item.id, content({ title: "Corrected wording" }));
  actionItems.selectProposal(item.id, 2);
  promoteActionItem(deps, item.id, {});

  expect(actionItems.get(item.id)?.decisions.map((one) => one.kind)).toEqual([
    "correct-proposal",
    "select-proposal",
    "promote",
  ]);
});

it("commits the Task and the Action Item's acceptance in one canonical generation", () => {
  const { store, actionItems, deps } = acceptedWorkspace();
  publishCanonical(store);
  const [item] = actionItems.materialize(extraction([proposed()]));
  const before = store.readGeneration();

  const { task } = promoteActionItem(deps, item.id, {});

  /* One generation, not two: a Task that exists while the Action Item still
     says pending is the orphan the recovery path exists to clean up, and the
     canonical bundle can hold both in a single commit. */
  expect(store.readGeneration()).toBe(before + 1);
  expect(store.readTasks().map((one) => one.id)).toEqual([task.id]);
  expect(store.readActionItems()[0].promotedTaskId).toBe(task.id);
  expect(store.readActionItems()[0].state).toBe("promoted");
});

it("commits a completed acceptance in one canonical generation too", () => {
  const { store, actionItems, deps } = acceptedWorkspace();
  publishCanonical(store);
  const [item] = actionItems.materialize(extraction([proposed()]));
  const before = store.readGeneration();

  const { task } = promoteActionItem(deps, item.id, { completed: true });

  expect(store.readGeneration()).toBe(before + 1);
  expect(store.readTasks()[0].status).toBe("completed");
  expect(store.readTasks()[0].completedAt).not.toBeNull();
  expect(store.readActionItems()[0].promotedTaskId).toBe(task.id);
});

/**
 * A record written before provenance existed keeps its identity and its own
 * labels (#359, MWR-047). The entry id and payload checksum are over the
 * checked payload as it was stored: reshaping a version-1 handoff on the way in
 * would silently rekey every Action Item already in the Workspace, which is
 * exactly what must not happen. The literal identity below is the one this
 * payload checksummed to before the change — the payload fields and the
 * canonical JSON are the same code — so a reshape fails here rather than in a
 * real Workspace.
 */
it("replays a stored version-1 handoff under the identity it was written with", () => {
  const { root, actionItems } = workspace();
  const legacyHandoff = storedHandoff();

  const [first] = actionItems.materialize(extraction([proposed({ handoff: legacyHandoff })]));
  const origin = first.proposalRevisions[0].origin;
  expect(origin.kind).toBe("extraction");
  expect(origin.kind === "extraction" ? origin.outputEntryId : null).toBe("ce_fe462b37e560e6f8");
  expect(origin.kind === "extraction" ? origin.payloadChecksum : null).toBe(
    "sha256:67ef450816f51405e39cc68cf7084e060737ebd3314dabe47938fb1449048d27",
  );

  const replay = actionItems.materialize(extraction([proposed({ handoff: legacyHandoff })]));

  expect(replay.map((item) => item.id)).toEqual([first.id]);
  expect(replay[0]?.handoff).toEqual(legacyHandoff);
  expect(actionItems.list()).toEqual([first]);
  expect(readFileSync(join(root, "tasks/action-items.json"), "utf8")).toContain(
    '"purpose": "Make the rollout verifiable"',
  );
});

/** A handoff as a Workspace or Run stored it before provenance existed. */
function storedHandoff(): MeetingHandoffRecord {
  return {
    version: 1,
    commitment: "explicit",
    purpose: "Make the rollout verifiable",
    responsibility: { names: ["Alice"], basis: "explicit", reason: "She said so" },
    completionCriteria: [{ text: "A recorded rollout", basis: "inferred" }],
    requiredInputs: ["Rollout plan"],
    missingInputs: [
      {
        information: "Deployment access",
        obtainBy: "Ask the deployment administrator",
        basis: "inferred",
      },
    ],
    dependencies: [
      {
        actionTitle: "Approve the rollout plan",
        condition: "Only after approval",
        basis: "explicit",
      },
    ],
    timing: {
      kind: "deadline",
      stated: "tomorrow",
      referenceDate: null,
      reasoning: "Relative to the meeting",
    },
    evidence: [{ quote: "We will do this together", speaker: "Alice", timestamp: "01:12" }],
    statusReasoning: "Still outstanding",
  };
}

/**
 * The affected state in isolation (#359): a Workspace holding a record written
 * before provenance existed beside one written after it. Nothing here is a live
 * migration — the point is that both read, promote and resolve in the same
 * Workspace, and that neither is rewritten into the other's shape.
 */
it("reads a Workspace holding both handoff shapes", () => {
  const { actionItems } = workspace();
  const current: MeetingHandoff = {
    version: 2,
    commitment: "explicit",
    purpose: { text: "Make the rollout verifiable", provenance: "suggested", sources: [] },
    responsibility: { names: ["Bob"], basis: "explicit", reason: "Bob said so" },
    completionCriteria: [
      {
        text: "A recorded rollout",
        provenance: "supported",
        sources: [{ quote: "we will roll it out", speaker: "Bob", timestamp: "02:00" }],
      },
    ],
    requiredInputs: [],
    missingInputs: [],
    dependencies: [
      {
        actionTitle: "Approve the rollout plan",
        condition: "Only after approval",
        provenance: "suggested",
        sources: [],
        references: "extracted",
      },
    ],
    timing: {
      kind: "deadline",
      stated: "tomorrow",
      referenceDate: null,
      reasoning: "Relative to the meeting",
    },
    evidence: [{ quote: "we will roll it out", speaker: "Bob", timestamp: "02:00" }],
    statusReasoning: "Still outstanding",
  };
  const items = actionItems.materialize(
    extraction([
      proposed({ title: "Approve the rollout plan", owner: "Alice" }),
      proposed({ title: "Legacy follow-up", handoff: storedHandoff() }),
      proposed({ title: "Current follow-up", owner: "Bob", handoff: current }),
    ]),
  );

  expect(items.map((item) => item.handoff?.version)).toEqual([undefined, 1, 2]);
  const references = actionItems.dependencyReferences(items);
  const legacy = items.find((item) => actionItemProposal(item).title === "Legacy follow-up")!;
  const held = items.find((item) => actionItemProposal(item).title === "Current follow-up")!;
  const target = items.find(
    (item) => actionItemProposal(item).title === "Approve the rollout plan",
  )!;

  /* Neither shape is resolved by today's titles; the newer one resolves to the
     record the checked output actually materialized. */
  expect(references[legacy.id]?.[0]?.target).toEqual({
    kind: "unresolved",
    reason: "not-resolved",
  });
  expect(references[held.id]?.[0]?.target).toMatchObject({
    kind: "action-item",
    actionItemId: target.id,
  });
  expect(actionItems.get(legacy.id)?.handoff?.version).toBe(1);
  expect(actionItems.get(held.id)?.handoff?.version).toBe(2);
});

/**
 * A dependency whose wording two checked entries share stays unresolved, even
 * when one of those entries is the one asking (#347): a duplicated title is
 * never evidence that the other record was meant, and resolving to it would be
 * the guessed identity the contract forbids.
 */
it("leaves a duplicated title unresolved even for the entry that carries it", () => {
  const { actionItems } = workspace();
  const doubled: MeetingHandoff = {
    version: 2,
    commitment: "explicit",
    purpose: { text: "Keep the rollout verifiable", provenance: "suggested", sources: [] },
    responsibility: { names: ["Alice"], basis: "explicit", reason: "Alice said so" },
    completionCriteria: [],
    requiredInputs: [],
    missingInputs: [],
    dependencies: [
      {
        actionTitle: "Approve the rollout plan",
        condition: "Only after approval",
        provenance: "suggested",
        sources: [],
        references: "extracted",
      },
    ],
    timing: {
      kind: "deadline",
      stated: "tomorrow",
      referenceDate: null,
      reasoning: "Relative to the meeting",
    },
    evidence: [{ quote: "We will do this together", speaker: "Alice", timestamp: "01:12" }],
    statusReasoning: "Still outstanding",
  };
  const items = actionItems.materialize(
    extraction([
      proposed({ title: "Approve the rollout plan" }),
      proposed({ title: "Approve the rollout plan", handoff: doubled }),
    ]),
  );

  const depender = items.find((item) => item.handoff?.version === 2)!;
  const references = actionItems.dependencyReferences(items);

  expect(references[depender.id]?.[0]?.target).toEqual({
    kind: "unresolved",
    reason: "ambiguous-title",
  });
  expect(depender.handoff?.version === 2 ? depender.handoff.dependencies[0]?.target : null).toEqual(
    {
      kind: "unresolved",
      reason: "ambiguous-title",
    },
  );
});
