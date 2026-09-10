import { TaskCutoverReceiptSchema } from "@chief-of-staff-demo/shared";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ActionItem, Task, TaskList, TaskCutoverReceipt } from "@chief-of-staff-demo/shared";
import { writeJsonVerifiedSync } from "../engine/commit.js";

/** The canonical bundle version this build writes and the newest it can read. */
const BUNDLE_FORMAT = 2;

interface Bundle {
  format: number;
  generation: number;
  tasks: Task[];
  lists: TaskList[];
  actionItems: ActionItem[];
  receipt: TaskCutoverReceipt;
}

/**
 * The Tasks product area's file-backed Workspace state (ADR-0058): Tasks, the
 * Task Lists they are filed into, and the Action Items a Meeting Debrief
 * proposed. No database and no event log — one trusted local user and the
 * agreed query volume do not justify a second persistence model.
 *
 * Like the Meetings store beside it, this holds nothing in memory: every call
 * re-reads the file and writes the whole list back atomically, so a Debrief
 * materializing Action Items and an owner completing a Task cannot lose each
 * other's writes.
 *
 * A file that exists and will not read as what it claims to be is refused, not
 * quietly narrowed to the records that still parse: every write persists the
 * whole list, so a silently shortened read is a silent deletion on the next
 * one.
 */
export class TaskStore {
  private readonly snapshotFile: string;
  private readonly tasksFile: string;
  private readonly listsFile: string;
  private readonly actionItemsFile: string;

  constructor(workspaceDir: string) {
    const dir = join(workspaceDir, "tasks");
    this.snapshotFile = join(dir, "state.json");
    this.tasksFile = join(dir, "tasks.json");
    this.listsFile = join(dir, "task-lists.json");
    this.actionItemsFile = join(dir, "action-items.json");
  }

  /**
   * Tasks written before Trash and External Task Links existed carry neither
   * field. They are filled in on the way out rather than rejected: an absent
   * field is a Task from an earlier version of this Workspace, not a damaged
   * record, and reading never writes.
   */
  readTasks(): Task[] {
    return this.read<Task>(this.tasksFile, "Task", isTask).map((task) => ({
      ...task,
      externalLink: task.externalLink ?? null,
      deletedAt: task.deletedAt ?? null,
    }));
  }

  writeTasks(tasks: Task[]): void {
    this.write("tasks", this.tasksFile, tasks);
  }

  readLists(): TaskList[] {
    return this.read<TaskList>(this.listsFile, "Task List", isTaskList);
  }

  writeLists(lists: TaskList[]): void {
    this.write("lists", this.listsFile, lists);
  }

  readActionItems(): ActionItem[] {
    return this.read<ActionItem>(this.actionItemsFile, "Action Item", isActionItem);
  }

  writeActionItems(items: ActionItem[]): void {
    this.write("actionItems", this.actionItemsFile, items);
  }

  cutoverReceipt(): TaskCutoverReceipt | null {
    return this.bundle()?.receipt ?? null;
  }

  /**
   * The canonical record's own version (#354). Every write bumps it, so a
   * caller that held an older one can be refused instead of overwriting a
   * change it never saw.
   */
  readGeneration(): number {
    return this.bundle()?.generation ?? 0;
  }

  /** One atomic publication: readers observe either all old records or all migrated records. */
  publishCutover(
    records: { tasks: Task[]; lists: TaskList[]; actionItems: ActionItem[] },
    receipt: TaskCutoverReceipt,
  ): void {
    writeJsonVerifiedSync(this.snapshotFile, this.nextBundle({ ...records, receipt }));
  }

  private bundle(): Bundle | null {
    if (!existsSync(this.snapshotFile)) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.snapshotFile, "utf8"));
    } catch {
      throw new TaskStoreCorruptionError(this.snapshotFile, "the canonical snapshot is unreadable");
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("tasks" in parsed) ||
      !Array.isArray(parsed.tasks) ||
      !parsed.tasks.every(isTask) ||
      !("lists" in parsed) ||
      !Array.isArray(parsed.lists) ||
      !parsed.lists.every(isTaskList) ||
      !("actionItems" in parsed) ||
      !Array.isArray(parsed.actionItems) ||
      !parsed.actionItems.every(isActionItem) ||
      !("receipt" in parsed) ||
      !TaskCutoverReceiptSchema.safeParse(parsed.receipt).success
    )
      throw new TaskStoreCorruptionError(this.snapshotFile, "the canonical snapshot is unreadable");
    /* A bundle written before the format was stamped is version 1; anything
       newer than this build understands is refused rather than read as if the
       fields it added were absent. */
    const format = "format" in parsed ? parsed.format : 1;
    const generation = "generation" in parsed ? parsed.generation : 0;
    if (
      typeof format !== "number" ||
      !Number.isSafeInteger(format) ||
      format < 1 ||
      typeof generation !== "number" ||
      !Number.isSafeInteger(generation) ||
      generation < 0
    ) {
      throw new TaskStoreCorruptionError(
        this.snapshotFile,
        "the canonical version metadata is invalid",
      );
    }
    if (format > BUNDLE_FORMAT) {
      throw new TaskStoreFormatError(this.snapshotFile, format);
    }
    return {
      format,
      generation,
      tasks: parsed.tasks,
      lists: parsed.lists,
      actionItems: parsed.actionItems,
      // Checked by the schema above; the field and the record agree here.
      receipt: parsed.receipt as TaskCutoverReceipt,
    };
  }

  /**
   * The canonical bundle as this build writes it: the current format stamped on
   * and the generation advanced, so a reader can tell this commit from the one
   * before it and a later build's records are never silently reinterpreted.
   */
  private nextBundle(next: Omit<Bundle, "format" | "generation">): Bundle {
    return { ...next, format: BUNDLE_FORMAT, generation: this.readGeneration() + 1 };
  }

  private write(
    key: "tasks" | "lists" | "actionItems",
    path: string,
    records: Task[] | TaskList[] | ActionItem[],
  ): void {
    const bundle = this.bundle();
    if (bundle)
      writeJsonVerifiedSync(this.snapshotFile, this.nextBundle({ ...bundle, [key]: records }));
    else writeJsonVerifiedSync(path, records);
  }

  private read<T>(path: string, record: string, guard: (value: unknown) => value is T): T[] {
    const bundle = this.bundle();
    if (bundle)
      return (
        path === this.tasksFile
          ? bundle.tasks
          : path === this.listsFile
            ? bundle.lists
            : bundle.actionItems
      ) as T[];
    if (!existsSync(path)) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      throw new TaskStoreCorruptionError(path, `the ${record} file is not valid JSON`);
    }
    if (!Array.isArray(parsed)) {
      throw new TaskStoreCorruptionError(path, `the ${record} file is not a list`);
    }
    /* Every entry, or none. Dropping the ones that fail the guard would read
       as a shorter list, and the next write — which persists the whole list —
       would then delete them for good. Refusing loudly keeps a damaged file
       recoverable. */
    const index = parsed.findIndex((entry) => !guard(entry));
    if (index !== -1) {
      throw new TaskStoreCorruptionError(path, `${record} ${index} is not a valid record`);
    }
    return parsed as T[];
  }
}

/**
 * A persisted file that exists and cannot be read as what it claims to be.
 * Explicit corruption, never an empty store: the difference between "you have
 * no Tasks" and "your Tasks are unreadable" is the whole point.
 */
export class TaskStoreCorruptionError extends Error {
  constructor(
    public readonly path: string,
    detail: string,
  ) {
    super(`Workspace Tasks are unreadable: ${detail}`);
    this.name = "TaskStoreCorruptionError";
  }
}

/** A canonical bundle from a later build, which this one must not rewrite. */
export class TaskStoreFormatError extends Error {
  constructor(
    public readonly path: string,
    public readonly format: number,
  ) {
    super(
      `Workspace Tasks are unreadable: the canonical snapshot uses format ${format}, newer than this build supports`,
    );
    this.name = "TaskStoreFormatError";
  }
}

function isTask(value: unknown): value is Task {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.title === "string" &&
    typeof candidate.listId === "string" &&
    typeof candidate.createdAt === "string" &&
    (candidate.status === "open" || candidate.status === "completed")
  );
}

function isTaskList(value: unknown): value is TaskList {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === "string" && typeof candidate.name === "string";
}

function isActionItem(value: unknown): value is ActionItem {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.proposal === "object" &&
    typeof candidate.source === "object" &&
    (candidate.state === "pending" ||
      candidate.state === "promoted" ||
      candidate.state === "dismissed")
  );
}
