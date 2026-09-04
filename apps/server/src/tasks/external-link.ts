import type { Task } from "@chief-of-staff-demo/shared";
import { TaskValidationError, type WorkspaceTasks } from "./tasks.js";

/**
 * Google Tasks as a Task Destination (issue #184, ADR-0056).
 *
 * Local first, always. A Task is committed to the Workspace before anything is
 * sent outward, and a Google failure leaves the Task exactly as usable as it
 * was — with a link that says `waiting` or `failed` rather than no Task at all.
 *
 * Nothing here reads Google's own Tasks. The one read this module makes is of
 * the account's Task Lists, so the owner can choose a container; their contents
 * are never fetched, and no Google Task ever becomes a Workspace Task.
 */

/** What the owner chose, as the Workspace stores it. */
export interface GoogleTasksDestinationSettings {
  enabled: boolean;
  taskListId: string;
  taskListTitle: string;
}

export interface TaskLinkingDeps {
  tasks: WorkspaceTasks;
  /** The stored Google Tasks settings, read live. */
  settings: () => GoogleTasksDestinationSettings;
  save: (settings: GoogleTasksDestinationSettings) => void;
  /** The account's Task Lists, or a refusal explaining why not. */
  listRemoteLists: () => Promise<{ id: string; title: string }[]>;
  /** Create one Google Task and answer with its identity. */
  createRemote: (
    taskListId: string,
    task: Task,
  ) => Promise<{ remoteId: string; url: string | null }>;
}

export class TaskLinking {
  constructor(private readonly deps: TaskLinkingDeps) {}

  settings(): GoogleTasksDestinationSettings {
    return this.deps.settings();
  }

  /** The Google Task Lists available as a destination. Containers only. */
  async availableLists(): Promise<{ id: string; title: string }[]> {
    return this.deps.listRemoteLists();
  }

  /**
   * Enable or disable Google Tasks, and choose the list. Enabling with a list
   * validates that Google still holds it — a destination that does not exist
   * would turn every later creation into the same failure, discovered one Task
   * at a time.
   *
   * Disabling keeps the remembered list and touches nothing else: the rest of
   * the Google connection, and every local Task, go on working.
   */
  async select(input: {
    enabled: boolean;
    taskListId?: string;
  }): Promise<GoogleTasksDestinationSettings> {
    const current = this.deps.settings();
    if (!input.enabled) {
      const next = { ...current, enabled: false };
      this.deps.save(next);
      return next;
    }
    const chosen = input.taskListId ?? current.taskListId;
    if (chosen === "") {
      throw new TaskValidationError(
        "invalid-destination",
        "Choose which Google Task List new Tasks are created in.",
      );
    }
    const lists = await this.deps.listRemoteLists();
    const match = lists.find((list) => list.id === chosen);
    if (!match) {
      throw new TaskValidationError(
        "invalid-destination",
        "Google does not have that Task List. Choose one of the lists it offers.",
      );
    }
    const next = { enabled: true, taskListId: match.id, taskListTitle: match.title };
    this.deps.save(next);
    return next;
  }

  /**
   * Create the external record for a Task already committed locally, and store
   * the one External Task Link it may have. A failure is recorded on the Task
   * rather than raised at the owner: the work is captured either way, and the
   * link is what is waiting.
   */
  async link(taskId: string): Promise<Task> {
    const task = this.deps.tasks.get(taskId);
    if (!task) {
      throw new TaskValidationError("task-not-found", `No Task with id ${taskId}`);
    }
    if (task.externalLink !== null && task.externalLink.state === "synchronized") {
      throw new TaskValidationError(
        "task-already-linked",
        "That Task already has an External Task Link.",
      );
    }
    if (task.destination.provider !== "google-tasks") {
      throw new TaskValidationError(
        "invalid-destination",
        "That Task is filed locally and has nothing to link to.",
      );
    }
    const baseline = {
      title: task.title,
      notes: task.notes,
      dueDate: task.dueDate,
      status: task.status,
    };
    /* Recorded before Google is called at all, so an outward write that never
       returns leaves a Task that says it is waiting rather than one that
       silently says nothing happened. */
    this.deps.tasks.recordExternalLink(task.id, {
      state: "waiting",
      destination: task.destination,
      remoteId: null,
      url: null,
      baseline,
      failure: null,
    });
    try {
      const created = await this.deps.createRemote(task.destination.googleTaskListId, task);
      return this.deps.tasks.recordExternalLink(task.id, {
        state: "synchronized",
        destination: task.destination,
        remoteId: created.remoteId,
        url: created.url,
        baseline,
        failure: null,
      });
    } catch (error) {
      return this.deps.tasks.recordExternalLink(task.id, {
        state: "failed",
        destination: task.destination,
        remoteId: null,
        url: null,
        baseline,
        failure: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
