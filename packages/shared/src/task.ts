/**
 * The Workspace's durable record of accepted work (ADR-0052, ADR-0054).
 *
 * A Task is canonical: it is created manually or promoted from an Action Item,
 * it is managed entirely without any external account, and an External Task
 * Link — when one exists at all — is a representation of it, never its source
 * of truth. Nothing here names a provider.
 *
 * A Task is also a snapshot. It survives deletion of the Meeting, Meeting
 * Debrief or Transcript it came from: `source` is a reference the surfaces
 * report as unavailable rather than a dependency that can take the Task with
 * it.
 */

/** The workspace owner's local ranking. Never mapped to a provider field. */
export const TASK_PRIORITIES = ["none", "low", "medium", "high"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export type TaskStatus = "open" | "completed";

/**
 * Inbox always exists and is the default Task List, so every Task has a valid
 * destination without the owner configuring one. Its identity is fixed rather
 * than minted, so a Workspace that has never written a Task List file still
 * has an Inbox to file into.
 */
export const INBOX_TASK_LIST_ID = "inbox" as const;
export const INBOX_TASK_LIST_NAME = "Inbox" as const;

/**
 * The external system and container a new Task is delivered to. `local` is the
 * default and creates no External Task Link — an outward write never happens
 * by accident. Google Tasks and Asana widen this union with their own
 * container fields when those destinations arrive.
 */
export interface TaskDestination {
  provider: "local";
}

export const LOCAL_TASK_DESTINATION: TaskDestination = { provider: "local" };

/**
 * Who is expected to perform a Task: the workspace owner, or one confirmed
 * Person Profile. This records responsibility only — it grants no access, no
 * notification, and no provider assignment.
 */
export type TaskResponsiblePerson =
  { kind: "owner" } | { kind: "person-profile"; profileId: string };

/**
 * Where an accepted Task came from. Null for a Task captured by hand, which is
 * the whole point of the field: a manual Task has no source to be unavailable.
 */
export interface TaskSource {
  kind: "action-item";
  actionItemId: string;
  debriefRunId: string;
  transcriptId: string;
  meetingId: string | null;
}

export interface Task {
  /** Workspace identity. Stable across every edit, and never derived from position. */
  id: string;
  title: string;
  notes: string;
  status: TaskStatus;
  /** Date-only `YYYY-MM-DD`, read as a calendar date in the Workspace timezone. */
  dueDate: string | null;
  priority: TaskPriority;
  /** Exactly one Task List. Inbox when the owner chose none. */
  listId: string;
  responsiblePerson: TaskResponsiblePerson | null;
  /** Resolved once at creation from the list default or an explicit override. */
  destination: TaskDestination;
  source: TaskSource | null;
  createdAt: string;
  updatedAt: string;
  /** Set while `status` is completed, cleared when the Task is reopened. */
  completedAt: string | null;
}

/**
 * One named collection of Tasks. Inbox is present in every Workspace and
 * cannot be renamed or deleted; every other list is the owner's own.
 */
export interface TaskList {
  id: string;
  name: string;
  /** Applied to Tasks filed here unless the creation names its own destination. */
  defaultDestination: TaskDestination;
}

/** Quick Add needs only a title; every other field has a defensible default. */
export interface TaskCreateInput {
  title: string;
  notes?: string;
  dueDate?: string | null;
  priority?: TaskPriority;
  listId?: string;
  responsiblePerson?: TaskResponsiblePerson | null;
  /** Overrides the Task List's default for this Task only. */
  destination?: TaskDestination;
}

/**
 * The mutable fields. Identity, source, creation time and destination are not
 * among them: editing a Task must never look like replacing it.
 */
export interface TaskUpdateInput {
  title?: string;
  notes?: string;
  dueDate?: string | null;
  priority?: TaskPriority;
  listId?: string;
  responsiblePerson?: TaskResponsiblePerson | null;
}

/** What the Tasks product reads: the Tasks and the lists they are filed into. */
export interface TaskIndex {
  tasks: Task[];
  lists: TaskList[];
}
