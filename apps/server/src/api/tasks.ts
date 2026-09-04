import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type {
  ActionItemIndex,
  ActionItemState,
  TaskCreateInput,
  TaskDestination,
  TaskIndex,
} from "@chief-of-staff-demo/shared";
import { TaskValidationError, type WorkspaceTasks } from "../tasks/tasks.js";
import type { ActionItemQuery, WorkspaceActionItems } from "../tasks/action-items.js";

export interface TasksApiContext {
  /** The Tasks product area's Workspace-owned interface; routes stay thin over it. */
  tasks: WorkspaceTasks;
  /** The Action Items a Meeting Debrief proposed, read here and owned there. */
  actionItems: WorkspaceActionItems;
}

/** HTTP status per refusal: bad input, a missing record, or a refused state change. */
const REFUSAL_STATUS: Record<TaskValidationError["code"], number> = {
  "invalid-title": 400,
  "invalid-notes": 400,
  "invalid-list-name": 400,
  "invalid-due-date": 400,
  "invalid-priority": 400,
  "invalid-responsible-person": 400,
  "invalid-destination": 400,
  "task-list-not-found": 404,
  "task-not-found": 404,
  "task-list-not-empty": 409,
  "inbox-is-permanent": 409,
};

const ACTION_ITEM_STATES: readonly ActionItemState[] = ["pending", "promoted", "dismissed"];

/**
 * The Tasks product namespace (ADR-0052): Task capture and editing, Task List
 * management, and the readable queue of Action Items awaiting review. No
 * provider is reachable here — every route is a Workspace-local operation, so
 * the whole product works with no external account connected.
 *
 * Action Items are readable but never writable through this namespace: they
 * are proposals until a decision is made, and they are not Tasks.
 */
export function registerTasksApi(app: FastifyInstance, ctx: TasksApiContext): void {
  const tasks = ctx.tasks;

  /** Every refused Task operation answers with its stable code and message. */
  function refuse(reply: FastifyReply, error: unknown): { error: string; message: string } {
    if (error instanceof TaskValidationError) {
      reply.code(REFUSAL_STATUS[error.code]);
      return { error: error.code, message: error.message };
    }
    throw error;
  }

  app.get("/api/tasks", async (request: FastifyRequest) => {
    const query = request.query as { listId?: string; status?: string };
    const status =
      query.status === "open" || query.status === "completed" ? query.status : undefined;
    const index: TaskIndex = {
      tasks: tasks.list({
        ...(query.listId ? { listId: query.listId } : {}),
        ...(status ? { status } : {}),
      }),
      lists: tasks.lists(),
    };
    return index;
  });

  app.post("/api/tasks", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const created = tasks.create((request.body ?? {}) as TaskCreateInput);
      reply.code(201);
      return created;
    } catch (error) {
      return refuse(reply, error);
    }
  });

  app.get("/api/tasks/:taskId", async (request: FastifyRequest, reply: FastifyReply) => {
    const { taskId } = request.params as { taskId: string };
    const task = tasks.get(taskId);
    if (!task) {
      reply.code(404);
      return { error: "task-not-found", message: `No Task with id ${taskId}` };
    }
    return task;
  });

  app.patch("/api/tasks/:taskId", async (request: FastifyRequest, reply: FastifyReply) => {
    const { taskId } = request.params as { taskId: string };
    try {
      return tasks.update(taskId, request.body ?? {});
    } catch (error) {
      return refuse(reply, error);
    }
  });

  /* POST, not PUT: completing is an action on a Task, and both directions are
     idempotent, so a repeated request is the same answer rather than a
     second completion time. */
  app.post("/api/tasks/:taskId/complete", async (request: FastifyRequest, reply: FastifyReply) => {
    const { taskId } = request.params as { taskId: string };
    try {
      return tasks.complete(taskId);
    } catch (error) {
      return refuse(reply, error);
    }
  });

  app.post("/api/tasks/:taskId/reopen", async (request: FastifyRequest, reply: FastifyReply) => {
    const { taskId } = request.params as { taskId: string };
    try {
      return tasks.reopen(taskId);
    } catch (error) {
      return refuse(reply, error);
    }
  });

  app.get("/api/task-lists", async () => ({ lists: tasks.lists() }));

  app.post("/api/task-lists", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body ?? {}) as { name?: string; defaultDestination?: TaskDestination };
    try {
      const created = tasks.createList({
        name: body.name ?? "",
        ...(body.defaultDestination ? { defaultDestination: body.defaultDestination } : {}),
      });
      reply.code(201);
      return created;
    } catch (error) {
      return refuse(reply, error);
    }
  });

  app.patch("/api/task-lists/:listId", async (request: FastifyRequest, reply: FastifyReply) => {
    const { listId } = request.params as { listId: string };
    try {
      return tasks.updateList(listId, request.body ?? {});
    } catch (error) {
      return refuse(reply, error);
    }
  });

  app.delete("/api/task-lists/:listId", async (request: FastifyRequest, reply: FastifyReply) => {
    const { listId } = request.params as { listId: string };
    try {
      tasks.deleteList(listId);
      /* The remaining lists rather than an empty 204: the surface that just
         deleted one needs to redraw them, and one answer beats two calls. */
      return { lists: tasks.lists() };
    } catch (error) {
      return refuse(reply, error);
    }
  });

  /**
   * The pending Action Item queue. A read, never a write: an Action Item is a
   * proposal until the owner promotes or dismisses it, and this namespace does
   * not treat one as a Task.
   */
  app.get("/api/action-items", async (request: FastifyRequest) => {
    const query = request.query as {
      state?: string;
      debriefRunId?: string;
      transcriptId?: string;
      meetingId?: string;
    };
    const filter: ActionItemQuery = {
      ...(ACTION_ITEM_STATES.includes(query.state as ActionItemState)
        ? { state: query.state as ActionItemState }
        : {}),
      ...(query.debriefRunId ? { debriefRunId: query.debriefRunId } : {}),
      ...(query.transcriptId ? { transcriptId: query.transcriptId } : {}),
      ...(query.meetingId ? { meetingId: query.meetingId } : {}),
    };
    const index: ActionItemIndex = { items: ctx.actionItems.list(filter) };
    return index;
  });
}
