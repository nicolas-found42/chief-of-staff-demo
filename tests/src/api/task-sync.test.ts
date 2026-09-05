import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { Task } from "@chief-of-staff-demo/shared";
import { registerTasksApi } from "../../../apps/server/src/api/tasks";
import { TaskStore } from "../../../apps/server/src/tasks/store";
import { WorkspaceTasks } from "../../../apps/server/src/tasks/tasks";
import { WorkspaceActionItems } from "../../../apps/server/src/tasks/action-items";
import {
  TaskLinking,
  type GoogleTasksDestinationSettings,
} from "../../../apps/server/src/tasks/external-link";

/**
 * Google completion and missing-record synchronization (issue #185, ADR-0056).
 *
 * The Workspace commits first and the link says what happened after: a local
 * completion is pushed outward, an unopposed external completion is applied
 * locally, and a remote record Google no longer holds leaves the Task intact
 * with a missing link the owner can recreate or remove.
 */
let app: FastifyInstance;
let settings: GoogleTasksDestinationSettings;
let createRemote: Mock<
  (taskListId: string, task: Task) => Promise<{ remoteId: string; url: string | null }>
>;
let readRemoteStatus: Mock<
  (taskListId: string, remoteId: string) => Promise<{ completed: boolean } | null>
>;
let updateRemoteStatus: Mock<
  (taskListId: string, remoteId: string, completed: boolean) => Promise<void>
>;

beforeEach(() => {
  const workspaceDir = mkdtempSync(join(tmpdir(), "cos-task-sync-"));
  const store = new TaskStore(workspaceDir);
  settings = { enabled: false, taskListId: "", taskListTitle: "" };
  createRemote = vi.fn(async () => ({ remoteId: "google_1", url: "https://tasks.google.com/1" }));
  readRemoteStatus = vi.fn(async () => ({ completed: false }));
  updateRemoteStatus = vi.fn(async () => {});
  const tasks = new WorkspaceTasks({
    store,
    now: () => new Date("2026-09-04T09:00:00.000Z"),
    isGoogleTasksEnabled: () => settings.enabled,
  });
  app = fastify();
  registerTasksApi(app, {
    tasks,
    actionItems: new WorkspaceActionItems({ store }),
    linking: new TaskLinking({
      tasks,
      settings: () => settings,
      save: (next) => {
        settings = next;
      },
      listRemoteLists: async () => [{ id: "list_work", title: "Work" }],
      createRemote,
      readRemoteStatus,
      updateRemoteStatus,
    }),
  });
  return app.ready();
});

afterEach(async () => {
  await app.close();
});

async function enable(): Promise<void> {
  const response = await app.inject({
    method: "PUT",
    url: "/api/tasks/google-destination",
    payload: { enabled: true, taskListId: "list_work" },
  });
  expect(response.statusCode).toBe(200);
}

async function captureToGoogle(title: string): Promise<Task> {
  const response = await app.inject({
    method: "POST",
    url: "/api/tasks",
    payload: {
      title,
      destination: {
        provider: "google-tasks",
        googleTaskListId: "list_work",
        googleTaskListTitle: "Work",
      },
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json<Task>();
}

async function link(taskId: string): Promise<Task> {
  const response = await app.inject({ method: "POST", url: `/api/tasks/${taskId}/link` });
  expect(response.statusCode).toBe(200);
  return response.json<Task>();
}

describe("pushing local completion outward", () => {
  it("pushes a local completion to the linked Google Task", async () => {
    await enable();
    const task = await captureToGoogle("Send the pricing sheet");
    await link(task.id);

    const completed = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/complete` });
    expect(completed.statusCode).toBe(200);
    expect(updateRemoteStatus).toHaveBeenCalledWith("list_work", "google_1", true);
    expect(completed.json<Task>()).toMatchObject({
      status: "completed",
      externalLink: { state: "synchronized", baseline: { status: "completed" } },
    });
  });

  it("pushes a local reopening to the linked Google Task", async () => {
    await enable();
    const task = await captureToGoogle("Book the room");
    await link(task.id);
    await app.inject({ method: "POST", url: `/api/tasks/${task.id}/complete` });
    updateRemoteStatus.mockClear();

    const reopened = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/reopen` });
    expect(reopened.statusCode).toBe(200);
    expect(updateRemoteStatus).toHaveBeenCalledWith("list_work", "google_1", false);
    expect(reopened.json<Task>()).toMatchObject({
      status: "open",
      externalLink: { state: "synchronized", baseline: { status: "open" } },
    });
  });

  it("repeats a completion without a second provider call", async () => {
    await enable();
    const task = await captureToGoogle("Send the pricing sheet");
    await link(task.id);

    await app.inject({ method: "POST", url: `/api/tasks/${task.id}/complete` });
    expect(updateRemoteStatus).toHaveBeenCalledTimes(1);

    const repeated = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/complete` });
    expect(repeated.statusCode).toBe(200);
    expect(updateRemoteStatus).toHaveBeenCalledTimes(1);
    expect(repeated.json<Task>()).toMatchObject({
      status: "completed",
      externalLink: { state: "synchronized", baseline: { status: "completed" } },
    });
  });
});

describe("applying an unopposed external completion", () => {
  it("updates the canonical Task when only Google completed", async () => {
    await enable();
    const task = await captureToGoogle("Send the pricing sheet");
    await link(task.id);
    readRemoteStatus.mockResolvedValueOnce({ completed: true });

    const synced = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/sync` });
    expect(synced.statusCode).toBe(200);
    expect(synced.json<Task>()).toMatchObject({
      status: "completed",
      externalLink: { state: "synchronized", baseline: { status: "completed" } },
    });
    /* Nothing to push: Google already holds the completion. */
    expect(updateRemoteStatus).not.toHaveBeenCalled();
  });

  it("applies an unopposed external reopening locally", async () => {
    await enable();
    const task = await captureToGoogle("Book the room");
    await link(task.id);
    await app.inject({ method: "POST", url: `/api/tasks/${task.id}/complete` });
    readRemoteStatus.mockResolvedValueOnce({ completed: false });

    const synced = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/sync` });
    expect(synced.statusCode).toBe(200);
    expect(synced.json<Task>()).toMatchObject({
      status: "open",
      completedAt: null,
      externalLink: { state: "synchronized", baseline: { status: "open" } },
    });
    expect(updateRemoteStatus).toHaveBeenCalledTimes(1);
  });

  it("leaves an agreeing Task untouched, including its timestamps", async () => {
    await enable();
    const task = await captureToGoogle("Send the pricing sheet");
    const linked = await link(task.id);

    const synced = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/sync` });
    expect(synced.statusCode).toBe(200);
    expect(synced.json<Task>().updatedAt).toBe(linked.updatedAt);
    expect(updateRemoteStatus).not.toHaveBeenCalled();
  });
});

describe("a Google Task that went missing", () => {
  it("leaves the local Task intact and marks the link missing", async () => {
    await enable();
    const task = await captureToGoogle("Send the pricing sheet");
    await link(task.id);
    readRemoteStatus.mockResolvedValueOnce(null);

    const synced = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/sync` });
    expect(synced.statusCode).toBe(200);
    expect(synced.json<Task>()).toMatchObject({
      title: "Send the pricing sheet",
      status: "open",
      externalLink: { state: "missing", remoteId: "google_1" },
    });
  });

  it("marks the link missing when a push finds the record gone", async () => {
    await enable();
    const task = await captureToGoogle("Book the room");
    await link(task.id);
    updateRemoteStatus.mockRejectedValueOnce(Object.assign(new Error("Not Found"), { code: 404 }));

    const completed = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/complete` });
    expect(completed.statusCode).toBe(200);
    expect(completed.json<Task>()).toMatchObject({
      title: "Book the room",
      status: "completed",
      externalLink: { state: "missing", remoteId: "google_1" },
    });
  });

  it("recreates the remote record and stores its replacement identity", async () => {
    await enable();
    const task = await captureToGoogle("Send the pricing sheet");
    await link(task.id);
    readRemoteStatus.mockResolvedValue(null);
    await app.inject({ method: "POST", url: `/api/tasks/${task.id}/sync` });
    createRemote.mockResolvedValueOnce({ remoteId: "google_2", url: "https://tasks.google.com/2" });

    const recreated = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/recreate` });
    expect(recreated.statusCode).toBe(200);
    expect(recreated.json<Task>()).toMatchObject({
      title: "Send the pricing sheet",
      status: "open",
      externalLink: {
        state: "synchronized",
        remoteId: "google_2",
        url: "https://tasks.google.com/2",
        baseline: { title: "Send the pricing sheet", status: "open" },
      },
    });
  });

  it("removes the link while preserving the local Task", async () => {
    await enable();
    const task = await captureToGoogle("Send the pricing sheet");
    await link(task.id);
    readRemoteStatus.mockResolvedValueOnce(null);
    await app.inject({ method: "POST", url: `/api/tasks/${task.id}/sync` });

    const removed = await app.inject({ method: "DELETE", url: `/api/tasks/${task.id}/link` });
    expect(removed.statusCode).toBe(200);
    expect(removed.json<Task>()).toMatchObject({
      title: "Send the pricing sheet",
      status: "open",
      externalLink: null,
    });
  });
});

describe("classified provider failures", () => {
  it("records an authentication failure without failing the local Task", async () => {
    await enable();
    const task = await captureToGoogle("Book the room");
    await link(task.id);
    updateRemoteStatus.mockRejectedValueOnce(
      Object.assign(new Error("Request had invalid authentication credentials"), { code: 401 }),
    );

    const completed = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/complete` });
    expect(completed.statusCode).toBe(200);
    expect(completed.json<Task>()).toMatchObject({
      status: "completed",
      externalLink: {
        state: "failed",
        remoteId: "google_1",
        failure: {
          kind: "authorization",
          message: "Google Tasks refused the saved sign-in. Sign in again.",
        },
      },
    });
  });

  it("names rate-limit and validation failures in fixed sentences", async () => {
    await enable();
    const task = await captureToGoogle("Send the pricing sheet");
    await link(task.id);
    updateRemoteStatus.mockRejectedValueOnce(
      Object.assign(new Error("quotaExceeded"), { code: 429 }),
    );

    const first = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/complete` });
    expect(first.json<Task>().externalLink).toMatchObject({
      state: "failed",
      failure: { kind: "rate-limit", message: "Google Tasks is rate-limited. Retry shortly." },
    });
  });
  it("reads Google's 403 quota exhaustion as a rate limit, not a sign-in problem", async () => {
    await enable();
    const task = await captureToGoogle("Send the pricing sheet");
    await link(task.id);
    updateRemoteStatus.mockRejectedValueOnce(
      Object.assign(new Error("rateLimitExceeded"), { code: 403 }),
    );

    const completed = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/complete` });
    expect(completed.json<Task>().externalLink).toMatchObject({
      state: "failed",
      failure: { kind: "rate-limit", message: "Google Tasks is rate-limited. Retry shortly." },
    });
  });

  it("redacts credential-shaped detail from an unclassified failure", async () => {
    await enable();
    const task = await captureToGoogle("Book the room");
    await link(task.id);
    updateRemoteStatus.mockRejectedValueOnce(
      new Error("transport failed with Bearer ya29.secret-token-value"),
    );

    const completed = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/complete` });
    const failure = completed.json<Task>().externalLink?.failure;
    expect(failure?.kind).toBe("unavailable");
    expect(failure?.message ?? "").not.toContain("ya29.secret-token-value");
    expect(completed.json<Task>().externalLink).toMatchObject({ state: "failed" });
  });
});

describe("completed Tasks stay completed", () => {
  it("completes the remote record when a completed Task is linked", async () => {
    await enable();
    const task = await captureToGoogle("Already done");
    await app.inject({ method: "POST", url: `/api/tasks/${task.id}/complete` });
    updateRemoteStatus.mockClear();

    const linked = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/link` });
    expect(linked.statusCode).toBe(200);
    expect(updateRemoteStatus).toHaveBeenCalledWith("list_work", "google_1", true);
    expect(linked.json<Task>()).toMatchObject({
      status: "completed",
      externalLink: { state: "synchronized", baseline: { status: "completed" } },
    });

    /* And the next read agrees, writing nothing: the fake Google now holds
       the completion the linking just sent, so the read converges for free. */
    readRemoteStatus.mockResolvedValueOnce({ completed: true });
    const synced = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/sync` });
    expect(synced.json<Task>()).toMatchObject({
      status: "completed",
      externalLink: { state: "synchronized", baseline: { status: "completed" } },
    });
  });

  it("completes the replacement record when a completed Task is recreated", async () => {
    await enable();
    const task = await captureToGoogle("Done while missing");
    await app.inject({ method: "POST", url: `/api/tasks/${task.id}/complete` });
    await link(task.id);
    /* Google loses the record; the sync discovers it and marks the link
       missing with the Task still completed. */
    readRemoteStatus.mockResolvedValueOnce(null);
    await app.inject({ method: "POST", url: `/api/tasks/${task.id}/sync` });
    createRemote.mockResolvedValueOnce({ remoteId: "google_2", url: "https://tasks.google.com/2" });

    const recreated = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/recreate` });
    expect(recreated.statusCode).toBe(200);
    expect(updateRemoteStatus).toHaveBeenLastCalledWith("list_work", "google_2", true);
    expect(recreated.json<Task>()).toMatchObject({
      status: "completed",
      externalLink: {
        state: "synchronized",
        remoteId: "google_2",
        baseline: { status: "completed" },
      },
    });
  });

  it("never reverts a completed Task whose outward write failed", async () => {
    await enable();
    const task = await captureToGoogle("Push failed");
    await link(task.id);
    updateRemoteStatus.mockRejectedValueOnce(
      Object.assign(new Error("backend error"), { code: 500 }),
    );
    await app.inject({ method: "POST", url: `/api/tasks/${task.id}/complete` });

    /* The read finds Google still open while the Task is completed and the
       baseline is open: only the Workspace moved, so applying Google would
       revert accepted work. The read refuses, and the Task stays completed. */
    readRemoteStatus.mockResolvedValueOnce({ completed: false });
    const synced = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/sync` });
    expect(synced.statusCode).toBe(200);
    expect(synced.json<Task>()).toMatchObject({
      status: "completed",
      externalLink: { state: "failed", remoteId: "google_1" },
    });

    /* Repeating the status write retries the interrupted push. */
    await app.inject({ method: "POST", url: `/api/tasks/${task.id}/reopen` });
    await app.inject({ method: "POST", url: `/api/tasks/${task.id}/complete` });
    const converged = await app.inject({ method: "GET", url: `/api/tasks/${task.id}` });
    expect(converged.json<Task>()).toMatchObject({
      status: "completed",
      externalLink: { state: "synchronized", baseline: { status: "completed" } },
    });
  });

  it("refuses a second link once a record exists, even after a failed push", async () => {
    await enable();
    const task = await captureToGoogle("One record only");
    await link(task.id);
    updateRemoteStatus.mockRejectedValueOnce(
      Object.assign(new Error("backend error"), { code: 500 }),
    );
    await app.inject({ method: "POST", url: `/api/tasks/${task.id}/complete` });

    const second = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/link` });
    expect(second.statusCode).toBe(409);
    expect(second.json<{ error: string }>().error).toBe("task-already-linked");
    expect(createRemote).toHaveBeenCalledTimes(1);
  });
});
