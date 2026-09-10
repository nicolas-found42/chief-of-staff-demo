import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { ActionItem, MeetingDebriefActionItem, Task } from "@chief-of-staff-demo/shared";
import { actionItemProposal } from "@chief-of-staff-demo/shared";
import { registerTasksApi } from "../../../apps/server/src/api/tasks";
import { TaskStore } from "../../../apps/server/src/tasks/store";
import { WorkspaceTasks } from "../../../apps/server/src/tasks/tasks";
import { WorkspaceActionItems } from "../../../apps/server/src/tasks/action-items";

/**
 * The owner's review commands over HTTP (issue #355): selecting a proposal
 * revision, correcting one, recording what a proposal means next to earlier
 * work, and suggesting a change to a Task that was already accepted. Each
 * binds the record version it was shown, so a command decided from a stale
 * read is refused rather than applied.
 */
let app: FastifyInstance;
let actionItems: WorkspaceActionItems;

beforeEach(() => {
  const workspaceDir = mkdtempSync(join(tmpdir(), "cos-action-item-review-"));
  const store = new TaskStore(workspaceDir);
  actionItems = new WorkspaceActionItems({ store });
  app = fastify();
  registerTasksApi(app, { tasks: new WorkspaceTasks({ store }), actionItems });
  return app.ready();
});

afterEach(async () => {
  await app.close();
});

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

/** Materialize `count` proposals and hand back the records. */
function materialize(items: MeetingDebriefActionItem[] = [proposed()]): ActionItem[] {
  return actionItems.materialize({
    debriefRunId: "run_1",
    transcriptId: "drive_fileA_r1",
    meetingId: "meeting_1",
    actionItems: items,
  });
}

const post = async (url: string, payload: Record<string, unknown> = {}) =>
  await app.inject({ method: "POST", url, payload });

it("records a correction as a new revision and waits for the owner to select it", async () => {
  const [item] = materialize();

  const corrected = await post(`/api/action-items/${item.id}/correct-proposal`, {
    content: { title: "Corrected wording", notes: "", dueDate: null, responsiblePerson: null },
    expectedVersion: item.version,
  });

  expect(corrected.statusCode).toBe(200);
  const after = corrected.json<{ actionItem: ActionItem }>().actionItem;
  expect(after.proposalRevisions).toHaveLength(2);
  expect(actionItemProposal(after).title).toBe("Follow up on the billing fix");

  const refused = await post(`/api/action-items/${item.id}/promote`, {});
  expect(refused.statusCode).toBe(409);

  const selected = await post(`/api/action-items/${item.id}/select-proposal`, {
    revision: 2,
    expectedVersion: after.version,
  });
  expect(selected.statusCode).toBe(200);
  expect(actionItemProposal(selected.json<{ actionItem: ActionItem }>().actionItem).title).toBe(
    "Corrected wording",
  );
  expect((await post(`/api/action-items/${item.id}/promote`, {})).statusCode).toBe(201);
});

it("refuses a review command decided from a version the record has moved past", async () => {
  const [item] = materialize();
  await post(`/api/action-items/${item.id}/correct-proposal`, {
    content: { title: "Corrected wording", notes: "", dueDate: null, responsiblePerson: null },
  });

  const stale = await post(`/api/action-items/${item.id}/select-proposal`, {
    revision: 2,
    expectedVersion: item.version,
  });

  expect(stale.statusCode).toBe(409);
  expect(actionItems.get(item.id)?.selectedRevision).toBe(1);
});

it("refuses a revision the record does not have", async () => {
  const [item] = materialize();

  const missing = await post(`/api/action-items/${item.id}/select-proposal`, { revision: 7 });

  expect(missing.statusCode).toBe(404);
});

it("keeps an owner-linked proposal as evidence rather than promoting it", async () => {
  const [earlier, later] = materialize([
    proposed(),
    proposed({ title: "Send Bob the rollout plan", owner: "Bob" }),
  ]);

  const reconciled = await post(`/api/action-items/${later.id}/reconcile`, {
    disposition: "evidence-of-historical",
    targetActionItemId: earlier.id,
  });

  expect(reconciled.statusCode).toBe(200);
  expect(reconciled.json<{ actionItem: ActionItem }>().actionItem.reconciledInto).toBe(earlier.id);
  expect((await post(`/api/action-items/${later.id}/promote`, {})).statusCode).toBe(409);
});

it("refuses to attach evidence to a record that is itself evidence", async () => {
  const [earlier, later] = materialize([
    proposed(),
    proposed({ title: "Send Bob the rollout plan", owner: "Bob" }),
  ]);
  await post(`/api/action-items/${later.id}/reconcile`, {
    disposition: "evidence-of-historical",
    targetActionItemId: earlier.id,
  });

  const cycle = await post(`/api/action-items/${earlier.id}/reconcile`, {
    disposition: "evidence-of-historical",
    targetActionItemId: later.id,
  });

  expect(cycle.statusCode).toBe(409);
});

it("suggests a change to an accepted Task and leaves the Task to the owner", async () => {
  const [item] = materialize();
  const task = (await post(`/api/action-items/${item.id}/promote`, {})).json<{ task: Task }>().task;

  const suggested = await post(`/api/action-items/${item.id}/amendments`, {
    taskId: task.id,
    fields: { dueDate: "2026-09-30" },
    observedTaskVersion: task.version,
  });

  expect(suggested.statusCode).toBe(201);
  const amendment = suggested.json<{ actionItem: ActionItem }>().actionItem.amendments[0];
  expect(amendment.status).toBe("suggested");
  const unchanged = await app.inject({ method: "GET", url: `/api/tasks/${task.id}` });
  expect(unchanged.json<Task>()).toMatchObject({ dueDate: task.dueDate, version: task.version });

  const applied = await post(`/api/action-items/amendments/${amendment.id}/resolve`, {
    status: "applied",
  });
  expect(applied.statusCode).toBe(200);
  expect(actionItems.get(item.id)?.amendments[0]?.status).toBe("applied");
});

it("refuses a Task edit decided from a version the Task has moved past", async () => {
  const [item] = materialize();
  const task = (await post(`/api/action-items/${item.id}/promote`, {})).json<{ task: Task }>().task;
  const edited = await app.inject({
    method: "PATCH",
    url: `/api/tasks/${task.id}`,
    payload: { title: "Owner's own wording", expectedVersion: task.version },
  });
  expect(edited.statusCode).toBe(200);

  const stale = await app.inject({
    method: "PATCH",
    url: `/api/tasks/${task.id}`,
    payload: { title: "Stale writer", expectedVersion: task.version },
  });

  expect(stale.statusCode).toBe(409);
  const current = await app.inject({ method: "GET", url: `/api/tasks/${task.id}` });
  expect(current.json<Task>().title).toBe("Owner's own wording");
});
