import type {
  ActionItem,
  ActionItemIndex,
  ActionItemState,
  Task,
  TaskCreateInput,
  TaskIndex,
  TaskList,
  TaskStatus,
  TaskUpdateInput,
} from "@chief-of-staff-demo/shared";
import { request } from "../client";

/**
 * The Tasks area's client: the Workspace's canonical record of accepted work —
 * capture, editing, completion and Task List management — and the readable
 * queue of Action Items a Meeting Debrief proposed. No endpoint here reaches a
 * provider, which is why the whole area works with nothing connected.
 * client.ts holds transport only.
 */

/** What the Tasks page narrows on (issue #175). Everything is optional. */
export interface TaskFilters {
  listId?: string;
  status?: TaskStatus;
  trashed?: boolean;
  search?: string;
  priority?: string;
  responsible?: string;
  linked?: boolean;
}

function taskQuery(query: TaskFilters = {}): string {
  const params = new URLSearchParams();
  if (query.listId) params.set("listId", query.listId);
  if (query.status) params.set("status", query.status);
  if (query.trashed) params.set("trashed", "true");
  if (query.search) params.set("search", query.search);
  if (query.priority) params.set("priority", query.priority);
  if (query.responsible) params.set("responsible", query.responsible);
  if (query.linked !== undefined) params.set("linked", String(query.linked));
  return params.size > 0 ? `?${params.toString()}` : "";
}

/** The Google Tasks destination, as the Tasks page reads and writes it. */
export interface GoogleTasksDestination {
  enabled: boolean;
  taskListId: string;
  taskListTitle: string;
  /** False when this Workspace composes no Google connection at all. */
  available: boolean;
}

export const tasksApi = {
  tasks: (query?: TaskFilters) => request<TaskIndex>(`/api/tasks${taskQuery(query)}`),
  createTask: (input: TaskCreateInput) =>
    request<Task>("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  updateTask: (taskId: string, input: TaskUpdateInput) =>
    request<Task>(`/api/tasks/${encodeURIComponent(taskId)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  completeTask: (taskId: string) =>
    request<Task>(`/api/tasks/${encodeURIComponent(taskId)}/complete`, { method: "POST" }),
  reopenTask: (taskId: string) =>
    request<Task>(`/api/tasks/${encodeURIComponent(taskId)}/reopen`, { method: "POST" }),
  createTaskList: (name: string) =>
    request<TaskList>("/api/task-lists", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    }),
  renameTaskList: (listId: string, name: string) =>
    request<TaskList>(`/api/task-lists/${encodeURIComponent(listId)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    }),
  deleteTaskList: (listId: string) =>
    request<{ lists: TaskList[] }>(`/api/task-lists/${encodeURIComponent(listId)}`, {
      method: "DELETE",
    }),
  trashTask: (taskId: string) =>
    request<Task>(`/api/tasks/${encodeURIComponent(taskId)}/trash`, { method: "POST" }),
  restoreTask: (taskId: string) =>
    request<Task>(`/api/tasks/${encodeURIComponent(taskId)}/restore`, { method: "POST" }),
  /* Confirmation travels in the request: the server refuses a deletion nobody
     said out loud, and this is the surface saying it. */
  deleteTaskForever: (taskId: string) =>
    request<{ deleted: string }>(`/api/tasks/${encodeURIComponent(taskId)}?confirm=true`, {
      method: "DELETE",
    }),
  actionItems: (state: ActionItemState = "pending") =>
    request<ActionItemIndex>(`/api/action-items?state=${state}`),
  promoteActionItem: (actionItemId: string, input: TaskUpdateInput & { completed?: boolean }) =>
    request<{ task: Task; actionItem: ActionItem }>(
      `/api/action-items/${encodeURIComponent(actionItemId)}/promote`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      },
    ),
  googleDestination: () => request<GoogleTasksDestination>("/api/tasks/google-destination"),
  googleLists: () => request<{ lists: { id: string; title: string }[] }>("/api/tasks/google-lists"),
  setGoogleDestination: (input: { enabled: boolean; taskListId?: string }) =>
    request<GoogleTasksDestination>("/api/tasks/google-destination", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  linkTask: (taskId: string) =>
    request<Task>(`/api/tasks/${encodeURIComponent(taskId)}/link`, { method: "POST" }),
};

/** The typed surface a Tasks page (or its test double) binds to. */
export type TasksClient = typeof tasksApi;
