import { randomBytes } from "node:crypto";
import type {
  Task,
  TaskCreateInput,
  TaskDestination,
  TaskList,
  TaskPriority,
  TaskResponsiblePerson,
  TaskStatus,
  TaskUpdateInput,
} from "@chief-of-staff-demo/shared";
import {
  INBOX_TASK_LIST_ID,
  INBOX_TASK_LIST_NAME,
  LOCAL_TASK_DESTINATION,
  TASK_PRIORITIES,
} from "@chief-of-staff-demo/shared";
import type { TaskStore } from "./store.js";

/** A refused Task operation, named by a stable code the surfaces render. */
export class TaskValidationError extends Error {
  constructor(
    public readonly code:
      | "invalid-title"
      | "invalid-notes"
      | "invalid-list-name"
      | "invalid-due-date"
      | "invalid-priority"
      | "invalid-responsible-person"
      | "invalid-destination"
      | "task-list-not-found"
      | "task-list-not-empty"
      | "inbox-is-permanent"
      | "task-not-found",
    message: string,
  ) {
    super(message);
    this.name = "TaskValidationError";
  }
}

export interface WorkspaceTasksDeps {
  store: TaskStore;
  now?: () => Date;
  /**
   * Whether one Person Profile may carry responsibility: it has to exist and
   * be confirmed. Responsibility is recorded against canonical identity, never
   * against a name typed into a field. Absent, only the owner is available —
   * which is what a Workspace with no Profile directory can honestly offer.
   */
  isConfirmedPerson?: (profileId: string) => boolean;
}

/** What a Task query narrows on. Everything is optional; nothing is required. */
export interface TaskQuery {
  listId?: string;
  status?: TaskStatus;
}

/**
 * The Tasks product area's Workspace-owned interface (ADR-0052).
 *
 * One deep module over the file store: Task capture, editing, completion and
 * Task List management, with every refusal named rather than thrown as a bare
 * string. No provider is reachable from here — a local Task operation succeeds
 * or fails on the Workspace write alone, which is exactly why the product
 * works with no external account at all.
 */
export class WorkspaceTasks {
  private readonly store: TaskStore;
  private readonly now: () => Date;
  private readonly isConfirmedPerson: (profileId: string) => boolean;

  constructor(deps: WorkspaceTasksDeps) {
    this.store = deps.store;
    this.now = deps.now ?? (() => new Date());
    this.isConfirmedPerson = deps.isConfirmedPerson ?? (() => false);
  }

  // ---------------------------------------------------------------------------
  // Task Lists
  // ---------------------------------------------------------------------------

  /**
   * Inbox first, then the owner's own lists in creation order. Inbox is
   * synthesized when nothing has persisted it, so a Workspace that has never
   * written a Task List file still reports the list every Task can be filed
   * into. Reading never writes.
   */
  lists(): TaskList[] {
    const persisted = this.store.readLists();
    const inbox = persisted.find((list) => list.id === INBOX_TASK_LIST_ID) ?? {
      id: INBOX_TASK_LIST_ID,
      name: INBOX_TASK_LIST_NAME,
      defaultDestination: LOCAL_TASK_DESTINATION,
    };
    return [inbox, ...persisted.filter((list) => list.id !== INBOX_TASK_LIST_ID)];
  }

  getList(listId: string): TaskList | null {
    return this.lists().find((list) => list.id === listId) ?? null;
  }

  createList(input: { name: string; defaultDestination?: TaskDestination }): TaskList {
    const list: TaskList = {
      id: newId("list", this.now()),
      name: requireName(input.name),
      defaultDestination: normalizeDestination(input.defaultDestination),
    };
    /* `lists()` carries Inbox, synthesized or not, so the first list the owner
       creates is also what persists Inbox for the first time. */
    this.store.writeLists([...this.lists(), list]);
    return list;
  }

  /**
   * Change one list. Both fields together, in one write: a rejected rename
   * must not leave a destination change persisted behind it.
   *
   * A name belongs to the owner's own lists only — Inbox has to stay
   * recognizable as the default every Task falls back to — while any list,
   * Inbox included, may name a default Task Destination. That default reaches
   * newly created Tasks only: an existing Task resolved its destination when
   * it was created, and the list changing its mind afterwards must not
   * silently redirect work already accepted.
   */
  updateList(
    listId: string,
    input: { name?: string; defaultDestination?: TaskDestination },
  ): TaskList {
    const lists = this.lists();
    const current = lists.find((list) => list.id === listId);
    if (!current) {
      throw new TaskValidationError("task-list-not-found", `No Task List with id ${listId}`);
    }
    if (input.name !== undefined && listId === INBOX_TASK_LIST_ID) {
      throw new TaskValidationError("inbox-is-permanent", "Inbox cannot be renamed");
    }
    const next: TaskList = {
      ...current,
      ...(input.name === undefined ? {} : { name: requireName(input.name) }),
      ...(input.defaultDestination === undefined
        ? {}
        : { defaultDestination: normalizeDestination(input.defaultDestination) }),
    };
    this.store.writeLists(lists.map((list) => (list.id === listId ? next : list)));
    return next;
  }

  /**
   * Delete an empty list of the owner's own. A non-empty list is refused
   * rather than emptied: its Tasks have to be moved or deleted deliberately,
   * so no accepted work disappears with a container.
   */
  deleteList(listId: string): void {
    if (listId === INBOX_TASK_LIST_ID) {
      throw new TaskValidationError("inbox-is-permanent", "Inbox cannot be deleted");
    }
    const lists = this.lists();
    if (!lists.some((list) => list.id === listId)) {
      throw new TaskValidationError("task-list-not-found", `No Task List with id ${listId}`);
    }
    const held = this.store.readTasks().filter((task) => task.listId === listId);
    if (held.length > 0) {
      throw new TaskValidationError(
        "task-list-not-empty",
        `That Task List still holds ${held.length} Task${held.length === 1 ? "" : "s"}. Move or delete them first.`,
      );
    }
    this.store.writeLists(lists.filter((list) => list.id !== listId));
  }

  // ---------------------------------------------------------------------------
  // Tasks
  // ---------------------------------------------------------------------------

  list(query: TaskQuery = {}): Task[] {
    return this.store
      .readTasks()
      .filter((task) => matches(query.listId, task.listId) && matches(query.status, task.status))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  get(taskId: string): Task | null {
    return this.store.readTasks().find((task) => task.id === taskId) ?? null;
  }

  /**
   * Capture one Task. Quick Add supplies a title and nothing else; the
   * defaults are Inbox, the workspace owner, open, no due date and no
   * priority, with the destination taken from the Task List unless this
   * creation overrides it.
   *
   * Nothing captured here has a source: a source is what a promotion records,
   * and promotion does not exist yet.
   */
  create(input: TaskCreateInput): Task {
    const title = requireTitle(input.title);
    const listId = input.listId ?? INBOX_TASK_LIST_ID;
    const list = this.getList(listId);
    if (!list) {
      throw new TaskValidationError("task-list-not-found", `No Task List with id ${listId}`);
    }
    const at = this.now().toISOString();
    const task: Task = {
      id: newId("task", this.now()),
      title,
      notes: requireNotes(input.notes ?? ""),
      status: "open",
      dueDate: requireDueDate(input.dueDate ?? null),
      priority: requirePriority(input.priority ?? "none"),
      listId,
      responsiblePerson: this.requireResponsiblePerson(
        input.responsiblePerson === undefined ? { kind: "owner" } : input.responsiblePerson,
      ),
      destination: normalizeDestination(input.destination ?? list.defaultDestination),
      source: null,
      createdAt: at,
      updatedAt: at,
      completedAt: null,
    };
    this.store.writeTasks([...this.store.readTasks(), task]);
    return task;
  }

  /**
   * Edit the mutable fields. Identity, source, creation time and destination
   * are untouched by construction: accepted work evolves independently of
   * whatever proposed it, and an edit is never a replacement.
   */
  update(taskId: string, input: TaskUpdateInput): Task {
    return this.edit(taskId, (task) => {
      const next: Task = { ...task };
      if (input.title !== undefined) next.title = requireTitle(input.title);
      if (input.notes !== undefined) next.notes = requireNotes(input.notes);
      if (input.dueDate !== undefined) next.dueDate = requireDueDate(input.dueDate);
      if (input.priority !== undefined) next.priority = requirePriority(input.priority);
      if (input.listId !== undefined) {
        if (!this.getList(input.listId)) {
          throw new TaskValidationError(
            "task-list-not-found",
            `No Task List with id ${input.listId}`,
          );
        }
        next.listId = input.listId;
      }
      if (input.responsiblePerson !== undefined) {
        next.responsiblePerson = this.requireResponsiblePerson(input.responsiblePerson);
      }
      return next;
    });
  }

  /** Idempotent: completing a completed Task keeps its original completion time. */
  complete(taskId: string): Task {
    return this.edit(taskId, (task) =>
      task.status === "completed"
        ? task
        : { ...task, status: "completed", completedAt: this.now().toISOString() },
    );
  }

  /** Idempotent, and the reverse of completion: the completion time is cleared. */
  reopen(taskId: string): Task {
    return this.edit(taskId, (task) =>
      task.status === "open" ? task : { ...task, status: "open", completedAt: null },
    );
  }

  // ---------------------------------------------------------------------------

  private edit(taskId: string, change: (task: Task) => Task): Task {
    const tasks = this.store.readTasks();
    const current = tasks.find((task) => task.id === taskId);
    if (!current) {
      throw new TaskValidationError("task-not-found", `No Task with id ${taskId}`);
    }
    const changed = change(current);
    if (changed === current) return current;
    const next: Task = { ...changed, updatedAt: this.now().toISOString() };
    this.store.writeTasks(tasks.map((task) => (task.id === taskId ? next : task)));
    return next;
  }

  /**
   * `unknown` rather than the typed shape: this runs over a request body, and
   * the profile it names has to be a Profile this Workspace actually holds.
   */
  private requireResponsiblePerson(value: unknown): TaskResponsiblePerson | null {
    if (value === null || value === undefined) return null;
    if (typeof value === "object") {
      const candidate = value as { kind?: unknown; profileId?: unknown };
      if (candidate.kind === "owner") return { kind: "owner" };
      if (
        candidate.kind === "person-profile" &&
        typeof candidate.profileId === "string" &&
        this.isConfirmedPerson(candidate.profileId)
      ) {
        return { kind: "person-profile", profileId: candidate.profileId };
      }
    }
    throw new TaskValidationError(
      "invalid-responsible-person",
      "A Responsible Person is the workspace owner or a confirmed Person Profile.",
    );
  }
}

/** An unset filter matches everything; a set one has to be equal. */
function matches<T>(expected: T | undefined, actual: T): boolean {
  return expected === undefined || expected === actual;
}

function requireTitle(value: unknown): string {
  const title = typeof value === "string" ? value.trim() : "";
  if (title === "") {
    throw new TaskValidationError("invalid-title", "A Task needs a title.");
  }
  return title;
}

function requireName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (name === "") {
    throw new TaskValidationError("invalid-list-name", "A Task List needs a name.");
  }
  return name;
}

function requireNotes(value: unknown): string {
  if (typeof value !== "string") {
    throw new TaskValidationError("invalid-notes", "Notes are text.");
  }
  return value;
}

/**
 * A date-only calendar date, read in the Workspace timezone. `2026-02-30`
 * parses as a shape and is still not a day, so the round trip through UTC is
 * what actually decides.
 */
function requireDueDate(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    if (!Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value) {
      return value;
    }
  }
  throw new TaskValidationError("invalid-due-date", "A due date is a calendar date, YYYY-MM-DD.");
}

function requirePriority(value: unknown): TaskPriority {
  if (TASK_PRIORITIES.includes(value as TaskPriority)) return value as TaskPriority;
  throw new TaskValidationError(
    "invalid-priority",
    `Task Priority is one of ${TASK_PRIORITIES.join(", ")}.`,
  );
}

/** Local only is the whole supported set today; a provider name is refused. */
function normalizeDestination(value: unknown): TaskDestination {
  if (value === undefined) return LOCAL_TASK_DESTINATION;
  if (
    typeof value === "object" &&
    value !== null &&
    (value as { provider?: unknown }).provider === "local"
  ) {
    return { provider: "local" };
  }
  throw new TaskValidationError("invalid-destination", "Local only is the supported destination.");
}

function newId(prefix: "task" | "list", now: Date): string {
  const stamp = now.toISOString().replace(/[-:.TZ]/g, "");
  return `${prefix}_${stamp}_${randomBytes(4).toString("hex")}`;
}
