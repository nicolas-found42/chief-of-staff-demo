import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type {
  ActionItemIndex,
  ActionItemState,
  TaskCreateInput,
  TaskDestination,
  TaskIndex,
  TaskPriority,
} from "@chief-of-staff-demo/shared";
import { TASK_PRIORITIES } from "@chief-of-staff-demo/shared";
import {
  TaskValidationError,
  type ResponsibleFilter,
  type TaskQuery,
  type WorkspaceTasks,
} from "../tasks/tasks.js";
import type { ActionItemQuery, WorkspaceActionItems } from "../tasks/action-items.js";
import { promoteActionItem } from "../tasks/promotion.js";
import type { TaskLinking } from "../tasks/external-link.js";

export interface TasksApiContext {
  /** The Tasks product area's Workspace-owned interface; routes stay thin over it. */
  tasks: WorkspaceTasks;
  /** The Action Items a Meeting Debrief proposed, read here and owned there. */
  actionItems: WorkspaceActionItems;
  /**
   * Google Tasks as an optional Task Destination. Absent when the Workspace
   * composes no Google connection at all, and every Task route below still
   * works — which is the point of the destination being optional.
   */
  linking?: TaskLinking;
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
  "task-not-in-trash": 409,
  "task-already-linked": 409,
  /* 428: the request is well-formed and the Task is deletable — what is
     missing is the person saying so. */
  "confirmation-required": 428,
};

/** Query strings carry text; the Responsible Person filter is three shapes. */
function responsibleFilter(value: string | undefined): ResponsibleFilter | undefined {
  if (value === undefined || value === "") return undefined;
  if (value === "owner") return { kind: "owner" };
  if (value === "nobody") return { kind: "nobody" };
  return { kind: "person-profile", profileId: value };
}

const ACTION_ITEM_STATES: readonly ActionItemState[] = ["pending", "promoted", "dismissed"];

/** The body `requireLinking` refuses with, alongside the 409 it sets. */
const NO_DESTINATION = {
  error: "invalid-destination",
  message: "No external Task Destination is available.",
};

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

  /**
   * The external destination, or the one refusal every route that needs it
   * gives: a Workspace that composes no Google connection has nothing to file
   * outward to, and says so once rather than four times.
   */
  function requireLinking(reply: FastifyReply): TaskLinking | null {
    if (ctx.linking) return ctx.linking;
    reply.code(409);
    return null;
  }

  /** Every refused Task operation answers with its stable code and message. */
  function refuse(reply: FastifyReply, error: unknown): { error: string; message: string } {
    if (error instanceof TaskValidationError) {
      reply.code(REFUSAL_STATUS[error.code]);
      return { error: error.code, message: error.message };
    }
    throw error;
  }

  /**
   * The Tasks a query selects, the lists they file into, and today's calendar
   * date in the Workspace timezone (issue #175). Today is served rather than
   * left to the browser: a date-only due date belongs to the owner's day.
   */
  app.get("/api/tasks", async (request: FastifyRequest) => {
    const query = request.query as {
      listId?: string;
      status?: string;
      trashed?: string;
      search?: string;
      priority?: string;
      responsible?: string;
      linked?: string;
    };
    const status =
      query.status === "open" || query.status === "completed" ? query.status : undefined;
    const responsible = responsibleFilter(query.responsible);
    const filter: TaskQuery = {
      ...(query.listId ? { listId: query.listId } : {}),
      ...(status ? { status } : {}),
      ...(query.trashed === "true" ? { trashed: true } : {}),
      ...(query.search ? { search: query.search } : {}),
      ...(TASK_PRIORITIES.includes(query.priority as TaskPriority)
        ? { priority: query.priority as TaskPriority }
        : {}),
      ...(responsible ? { responsible } : {}),
      ...(query.linked === "true" || query.linked === "false"
        ? { linked: query.linked === "true" }
        : {}),
    };
    const selected = tasks.list(filter);
    const index: TaskIndex = {
      tasks: selected,
      lists: tasks.lists(),
      today: tasks.today(),
      /* Asked of the Action Items rather than stored on the Task: a source
         becomes unavailable long after the Task was written, and a snapshot
         that rewrote itself when its source went away would not be one. */
      unavailableSources: selected
        .filter(
          (task) => task.source !== null && ctx.actionItems.get(task.source.actionItemId) === null,
        )
        .map((task) => task.id),
    };
    return index;
  });

  /**
   * Capture one Task. The Workspace write commits first and answers alone; an
   * external destination is a second, separate step the surface takes with the
   * Task it already has (ADR-0056), so Google being slow or broken can never
   * cost someone the Task they just captured.
   */
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

  app.post("/api/tasks/:taskId/trash", async (request: FastifyRequest, reply: FastifyReply) => {
    const { taskId } = request.params as { taskId: string };
    try {
      return tasks.trash(taskId);
    } catch (error) {
      return refuse(reply, error);
    }
  });

  app.post("/api/tasks/:taskId/restore", async (request: FastifyRequest, reply: FastifyReply) => {
    const { taskId } = request.params as { taskId: string };
    try {
      return tasks.restore(taskId);
    } catch (error) {
      return refuse(reply, error);
    }
  });

  /* Confirmation travels in the request rather than being assumed by the
     method: DELETE says what to do, and `confirm` says that someone meant it. */
  app.delete("/api/tasks/:taskId", async (request: FastifyRequest, reply: FastifyReply) => {
    const { taskId } = request.params as { taskId: string };
    const { confirm } = request.query as { confirm?: string };
    try {
      tasks.deleteForever(taskId, { confirmed: confirm === "true" });
      return { deleted: taskId };
    } catch (error) {
      return refuse(reply, error);
    }
  });

  /**
   * Send one already-committed Task outward. Answers with the Task and its
   * link whether Google accepted or refused: a failed link is a state of a
   * perfectly good Task, not an error about it.
   */
  app.post("/api/tasks/:taskId/link", async (request: FastifyRequest, reply: FastifyReply) => {
    const { taskId } = request.params as { taskId: string };
    const linking = requireLinking(reply);
    if (!linking) return NO_DESTINATION;
    try {
      return await linking.link(taskId);
    } catch (error) {
      return refuse(reply, error);
    }
  });

  /**
   * The Google Tasks destination (issue #184). Reading it never reaches
   * Google; only choosing a list does, and only to list the containers the
   * account offers.
   */
  app.get("/api/tasks/google-destination", async () => {
    if (!ctx.linking) {
      return { enabled: false, taskListId: "", taskListTitle: "", available: false };
    }
    return { ...ctx.linking.settings(), available: true };
  });

  app.get("/api/tasks/google-lists", async (_request: FastifyRequest, reply: FastifyReply) => {
    const linking = requireLinking(reply);
    if (!linking) return NO_DESTINATION;
    try {
      return { lists: await linking.availableLists() };
    } catch (error) {
      reply.code(502);
      return {
        error: "google-unavailable",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  });

  app.put("/api/tasks/google-destination", async (request: FastifyRequest, reply: FastifyReply) => {
    const linking = requireLinking(reply);
    if (!linking) return NO_DESTINATION;
    const body = (request.body ?? {}) as { enabled?: boolean; taskListId?: string };
    try {
      return {
        ...(await linking.select({
          enabled: body.enabled === true,
          ...(body.taskListId === undefined ? {} : { taskListId: body.taskListId }),
        })),
        available: true,
      };
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

  /**
   * Promote one reviewed Action Item into a Task (issue #178). The body is the
   * review panel's accepted fields; anything it leaves out falls back to the
   * proposal, so an owner who changed nothing gets what the meeting said.
   *
   * 201 for the promotion that happened, 200 for one that already had: a retry
   * answers with the same Task rather than making a second one.
   */
  app.post(
    "/api/action-items/:actionItemId/promote",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { actionItemId } = request.params as { actionItemId: string };
      try {
        const result = promoteActionItem(
          { tasks, actionItems: ctx.actionItems },
          actionItemId,
          request.body ?? {},
        );
        reply.code(result.created ? 201 : 200);
        return { task: result.task, actionItem: result.actionItem };
      } catch (error) {
        return refuse(reply, error);
      }
    },
  );
}
