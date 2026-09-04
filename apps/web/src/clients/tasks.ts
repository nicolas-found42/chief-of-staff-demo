import type {
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

function taskQuery(query: { listId?: string; status?: TaskStatus } = {}): string {
  const params = new URLSearchParams();
  if (query.listId) params.set("listId", query.listId);
  if (query.status) params.set("status", query.status);
  return params.size > 0 ? `?${params.toString()}` : "";
}

export const tasksApi = {
  tasks: (query?: { listId?: string; status?: TaskStatus }) =>
    request<TaskIndex>(`/api/tasks${taskQuery(query)}`),
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
  actionItems: (state: ActionItemState = "pending") =>
    request<ActionItemIndex>(`/api/action-items?state=${state}`),
};

/** The typed surface a Tasks page (or its test double) binds to. */
export type TasksClient = typeof tasksApi;
