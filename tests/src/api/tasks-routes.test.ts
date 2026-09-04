import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Task, TaskIndex, TaskList } from "@chief-of-staff-demo/shared";
import { registerTasksApi } from "../../../apps/server/src/api/tasks";
import { TaskStore, TaskStoreCorruptionError } from "../../../apps/server/src/tasks/store";
import { WorkspaceTasks } from "../../../apps/server/src/tasks/tasks";
import { WorkspaceActionItems } from "../../../apps/server/src/tasks/action-items";

/**
 * The Tasks product namespace `/api/tasks` and `/api/task-lists` (issues #173,
 * #174) over a real server and a temporary Workspace. No provider is reachable
 * here at all — which is the point: the whole product has to work with nothing
 * connected.
 */
let app: FastifyInstance;
let workspaceDir: string;
/** Profile ids this Workspace treats as confirmed; set per test. */
let confirmedProfiles: Set<string>;
let clock: Date;

function compose(): FastifyInstance {
  const store = new TaskStore(workspaceDir);
  const instance = fastify();
  registerTasksApi(instance, {
    tasks: new WorkspaceTasks({
      store,
      now: () => clock,
      isConfirmedPerson: (profileId) => confirmedProfiles.has(profileId),
    }),
    actionItems: new WorkspaceActionItems({ store, now: () => clock }),
  });
  return instance;
}

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "cos-tasks-routes-"));
  confirmedProfiles = new Set<string>();
  clock = new Date("2026-09-04T09:00:00.000Z");
  app = compose();
  return app.ready();
});

afterEach(async () => {
  await app.close();
});

async function quickAdd(title: string): Promise<Task> {
  const response = await app.inject({ method: "POST", url: "/api/tasks", payload: { title } });
  expect(response.statusCode).toBe(201);
  return response.json<Task>();
}

async function index(query = ""): Promise<TaskIndex> {
  const response = await app.inject({ method: "GET", url: `/api/tasks${query}` });
  expect(response.statusCode).toBe(200);
  return response.json<TaskIndex>();
}

describe("capturing a Task", () => {
  it("takes a title alone and fills every other field with a defensible default", async () => {
    const task = await quickAdd("  Send the billing follow-up  ");

    expect(task).toMatchObject({
      title: "Send the billing follow-up",
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
    });
    expect(task.id).toMatch(/^task_/);
  });

  it("lists the Task at /api/tasks beside the Task Lists it can be filed into", async () => {
    const created = await quickAdd("Draft the recap");

    const payload = await index();
    expect(payload.tasks.map((task) => task.id)).toEqual([created.id]);
    expect(payload.lists).toEqual([
      { id: "inbox", name: "Inbox", defaultDestination: { provider: "local" } },
    ]);
  });

  it("keeps the Task and its identity across a restart of the application", async () => {
    const created = await quickAdd("Survives a restart");

    await app.close();
    app = compose();
    await app.ready();

    const payload = await index();
    expect(payload.tasks).toEqual([created]);
  });

  it("refuses a blank title and persists nothing", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: { title: " " },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string }>().error).toBe("invalid-title");
    expect((await index()).tasks).toEqual([]);
  });
});

describe("completing and reopening", () => {
  it("is idempotent in both directions and keeps the first completion time", async () => {
    const task = await quickAdd("Close the loop");

    clock = new Date("2026-09-04T10:00:00.000Z");
    const completed = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/complete` });
    expect(completed.json<Task>()).toMatchObject({
      status: "completed",
      completedAt: "2026-09-04T10:00:00.000Z",
    });

    clock = new Date("2026-09-04T11:00:00.000Z");
    const again = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/complete` });
    expect(again.json<Task>()).toEqual(completed.json<Task>());

    const reopened = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/reopen` });
    expect(reopened.json<Task>()).toMatchObject({ status: "open", completedAt: null });

    const stillOpen = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/reopen` });
    expect(stillOpen.json<Task>()).toEqual(reopened.json<Task>());
  });

  it("separates completed work from open work in the listing", async () => {
    const open = await quickAdd("Still to do");
    const done = await quickAdd("Already done");
    await app.inject({ method: "POST", url: `/api/tasks/${done.id}/complete` });

    expect((await index("?status=open")).tasks.map((task) => task.id)).toEqual([open.id]);
    expect((await index("?status=completed")).tasks.map((task) => task.id)).toEqual([done.id]);
  });

  it("answers 404 for a Task that does not exist", async () => {
    const response = await app.inject({ method: "POST", url: "/api/tasks/task_nope/complete" });
    expect(response.statusCode).toBe(404);
    expect(response.json<{ error: string }>().error).toBe("task-not-found");
  });
});

describe("editing Task details", () => {
  it("edits every mutable field while identity, source and creation time stand", async () => {
    confirmedProfiles.add("profile_alice");
    const task = await quickAdd("Rough title");
    const list = await createList("Billing");

    clock = new Date("2026-09-05T09:00:00.000Z");
    const response = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${task.id}`,
      payload: {
        title: "Send the billing follow-up",
        notes: "Include the Q3 numbers.",
        dueDate: "2026-09-11",
        priority: "high",
        listId: list.id,
        responsiblePerson: { kind: "person-profile", profileId: "profile_alice" },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<Task>()).toMatchObject({
      id: task.id,
      source: null,
      createdAt: task.createdAt,
      updatedAt: "2026-09-05T09:00:00.000Z",
      title: "Send the billing follow-up",
      notes: "Include the Q3 numbers.",
      dueDate: "2026-09-11",
      priority: "high",
      listId: list.id,
      responsiblePerson: { kind: "person-profile", profileId: "profile_alice" },
    });
  });

  it("holds Task Priority to none, low, medium and high", async () => {
    const task = await quickAdd("Priority");

    for (const priority of ["none", "low", "medium", "high"] as const) {
      const accepted = await app.inject({
        method: "PATCH",
        url: `/api/tasks/${task.id}`,
        payload: { priority },
      });
      expect(accepted.json<Task>().priority).toBe(priority);
    }

    const refused = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${task.id}`,
      payload: { priority: "urgent" },
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json<{ error: string }>().error).toBe("invalid-priority");
  });

  it("keeps a due date a calendar date and refuses anything that is not one", async () => {
    const task = await quickAdd("Due");

    for (const dueDate of ["2026-09-11T00:00:00.000Z", "2026-02-30", "11/09/2026"]) {
      const refused = await app.inject({
        method: "PATCH",
        url: `/api/tasks/${task.id}`,
        payload: { dueDate },
      });
      expect(refused.statusCode, dueDate).toBe(400);
      expect(refused.json<{ error: string }>().error).toBe("invalid-due-date");
    }

    const cleared = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${task.id}`,
      payload: { dueDate: null },
    });
    expect(cleared.json<Task>().dueDate).toBeNull();
  });

  it("records responsibility only against the owner or a confirmed Person Profile", async () => {
    const task = await quickAdd("Responsibility");

    const refused = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${task.id}`,
      payload: { responsiblePerson: { kind: "person-profile", profileId: "profile_unknown" } },
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json<{ error: string }>().error).toBe("invalid-responsible-person");

    const cleared = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${task.id}`,
      payload: { responsiblePerson: null },
    });
    expect(cleared.json<Task>().responsiblePerson).toBeNull();
  });
});

async function createList(name: string): Promise<TaskList> {
  const response = await app.inject({ method: "POST", url: "/api/task-lists", payload: { name } });
  expect(response.statusCode).toBe(201);
  return response.json<TaskList>();
}

describe("organizing Task Lists", () => {
  it("always has Inbox, and adds and renames the owner's own lists beside it", async () => {
    const before = await app.inject({ method: "GET", url: "/api/task-lists" });
    expect(before.json<{ lists: TaskList[] }>().lists).toEqual([
      { id: "inbox", name: "Inbox", defaultDestination: { provider: "local" } },
    ]);

    const list = await createList("Billing");
    const renamed = await app.inject({
      method: "PATCH",
      url: `/api/task-lists/${list.id}`,
      payload: { name: "Billing and finance" },
    });
    expect(renamed.json<TaskList>()).toMatchObject({ id: list.id, name: "Billing and finance" });

    const after = await app.inject({ method: "GET", url: "/api/task-lists" });
    expect(after.json<{ lists: TaskList[] }>().lists.map((entry) => entry.name)).toEqual([
      "Inbox",
      "Billing and finance",
    ]);
  });

  it("refuses a rename that leaves the list nameless, and persists nothing of it", async () => {
    const list = await createList("Billing");

    const refused = await app.inject({
      method: "PATCH",
      url: `/api/task-lists/${list.id}`,
      payload: { name: "  ", defaultDestination: { provider: "local" } },
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json<{ error: string }>().error).toBe("invalid-list-name");

    const after = await app.inject({ method: "GET", url: "/api/task-lists" });
    expect(after.json<{ lists: TaskList[] }>().lists).toContainEqual(list);
  });

  it("refuses to rename or delete Inbox", async () => {
    const renamed = await app.inject({
      method: "PATCH",
      url: "/api/task-lists/inbox",
      payload: { name: "Everything" },
    });
    expect(renamed.statusCode).toBe(409);
    expect(renamed.json<{ error: string }>().error).toBe("inbox-is-permanent");

    const deleted = await app.inject({ method: "DELETE", url: "/api/task-lists/inbox" });
    expect(deleted.statusCode).toBe(409);
  });

  it("refuses to delete a list that still holds Tasks, and accepts it once emptied", async () => {
    const list = await createList("Billing");
    const task = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: { title: "Filed here", listId: list.id },
    });

    const refused = await app.inject({ method: "DELETE", url: `/api/task-lists/${list.id}` });
    expect(refused.statusCode).toBe(409);
    expect(refused.json<{ error: string }>().error).toBe("task-list-not-empty");

    await app.inject({
      method: "PATCH",
      url: `/api/tasks/${task.json<Task>().id}`,
      payload: { listId: "inbox" },
    });
    const accepted = await app.inject({ method: "DELETE", url: `/api/task-lists/${list.id}` });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json<{ lists: TaskList[] }>().lists.map((entry) => entry.id)).toEqual([
      "inbox",
    ]);
  });

  it("applies the list's default Task Destination and lets one Task override it", async () => {
    const list = await createList("Billing");
    expect(list.defaultDestination).toEqual({ provider: "local" });

    const filed = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: { title: "Uses the list default", listId: list.id },
    });
    expect(filed.json<Task>().destination).toEqual({ provider: "local" });

    const overridden = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: {
        title: "Names its own destination",
        listId: list.id,
        destination: { provider: "local" },
      },
    });
    expect(overridden.json<Task>().destination).toEqual({ provider: "local" });

    const rejected = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: { title: "Nowhere", destination: { provider: "carrier-pigeon" } },
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json<{ error: string }>().error).toBe("invalid-destination");
  });

  it("accepts a default Task Destination on any list, including Inbox", async () => {
    const set = await app.inject({
      method: "PATCH",
      url: "/api/task-lists/inbox",
      payload: { defaultDestination: { provider: "local" } },
    });
    expect(set.statusCode).toBe(200);
    expect(set.json<TaskList>().defaultDestination).toEqual({ provider: "local" });

    const refused = await app.inject({
      method: "PATCH",
      url: "/api/task-lists/inbox",
      payload: { defaultDestination: { provider: "carrier-pigeon" } },
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json<{ error: string }>().error).toBe("invalid-destination");
  });

  it("files a Task into a list that does not exist nowhere at all", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: { title: "Homeless", listId: "list_nope" },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json<{ error: string }>().error).toBe("task-list-not-found");
    expect((await index()).tasks).toEqual([]);
  });
});

/**
 * A damaged Workspace has to say so. Every write persists the whole list, so a
 * read that quietly dropped what it could not recognize would delete those
 * records for good on the very next Quick Add.
 */
describe("a Workspace whose Task file cannot be read", () => {
  function writeTaskFile(content: string): TaskStore {
    mkdirSync(join(workspaceDir, "tasks"), { recursive: true });
    writeFileSync(join(workspaceDir, "tasks", "tasks.json"), content, "utf8");
    return new TaskStore(workspaceDir);
  }

  it("reports corruption rather than an empty store", () => {
    expect(() => writeTaskFile("{ not json").readTasks()).toThrow(TaskStoreCorruptionError);
    expect(() => writeTaskFile('{"tasks":[]}').readTasks()).toThrow(TaskStoreCorruptionError);
    expect(() => writeTaskFile('[{"id":"task_1"}]').readTasks()).toThrow(TaskStoreCorruptionError);
  });

  it("reads a Workspace that has simply never written one as empty", () => {
    expect(new TaskStore(workspaceDir).readTasks()).toEqual([]);
  });
});
