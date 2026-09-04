import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type {
  ActionItem,
  PersonProfile,
  Task,
  TaskList,
  TaskPriority,
  TaskResponsiblePerson,
} from "@chief-of-staff-demo/shared";
import {
  INBOX_TASK_LIST_ID,
  TASK_GROUPS,
  TASK_GROUP_LABELS,
  TASK_PRIORITIES,
  groupTasks,
} from "@chief-of-staff-demo/shared";
import { errorMessage } from "../client";
import { tasksApi, type GoogleTasksDestination, type TasksClient } from "../clients/tasks";
import { peopleApi, type PeopleClient } from "../clients/people";
import { usePageFocus } from "../usePageFocus";
import { useTitle } from "../useTitle";

/**
 * Tasks — the fifth product area (ADR-0052), and the canonical home of
 * accepted work. Everything here is a Workspace operation: no Google account,
 * no Asana token, and no connection state can stop a Task being captured,
 * edited, completed or filed.
 *
 * The pending Action Items section reads proposals a Meeting Debrief made. It
 * is deliberately a different section with different controls: a proposal is
 * not accepted work, and this page never lets one quietly become a Task.
 */

/** The owner, nobody, or a confirmed Person Profile, as one select value. */
const OWNER_VALUE = "owner";
const NOBODY_VALUE = "";

function responsibleValue(person: TaskResponsiblePerson | null): string {
  if (person === null) return NOBODY_VALUE;
  return person.kind === "owner" ? OWNER_VALUE : person.profileId;
}

function responsibleFromValue(value: string): TaskResponsiblePerson | null {
  if (value === NOBODY_VALUE) return null;
  return value === OWNER_VALUE ? { kind: "owner" } : { kind: "person-profile", profileId: value };
}

function personName(profiles: PersonProfile[], profileId: string): string {
  return profiles.find((profile) => profile.id === profileId)?.fullName ?? profileId;
}

function responsibleLabel(person: TaskResponsiblePerson | null, profiles: PersonProfile[]): string {
  if (person === null) return "Nobody";
  return person.kind === "owner" ? "You" : personName(profiles, person.profileId);
}

function listName(lists: TaskList[], listId: string): string {
  return lists.find((list) => list.id === listId)?.name ?? listId;
}

/** The fields an expanded Task form edits, as strings the inputs hold. */
interface TaskFormValues {
  title: string;
  notes: string;
  dueDate: string;
  priority: TaskPriority;
  listId: string;
  responsible: string;
}

function formValuesFrom(task: Task): TaskFormValues {
  return {
    title: task.title,
    notes: task.notes,
    dueDate: task.dueDate ?? "",
    priority: task.priority,
    listId: task.listId,
    responsible: responsibleValue(task.responsiblePerson),
  };
}

/** The shared field set — the same in Quick Add's expansion and in an edit. */
function TaskFields({
  idPrefix,
  values,
  lists,
  profiles,
  onChange,
}: {
  idPrefix: string;
  values: TaskFormValues;
  lists: TaskList[];
  profiles: PersonProfile[];
  onChange: (values: TaskFormValues) => void;
}) {
  const set = <K extends keyof TaskFormValues>(key: K, value: TaskFormValues[K]) =>
    onChange({ ...values, [key]: value });
  return (
    <div className="form-grid">
      <div className="field">
        <label htmlFor={`${idPrefix}-notes`}>Notes</label>
        <textarea
          id={`${idPrefix}-notes`}
          rows={3}
          value={values.notes}
          onChange={(event) => set("notes", event.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor={`${idPrefix}-due`}>Due date</label>
        <input
          id={`${idPrefix}-due`}
          type="date"
          value={values.dueDate}
          onChange={(event) => set("dueDate", event.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor={`${idPrefix}-priority`}>Priority</label>
        <select
          id={`${idPrefix}-priority`}
          value={values.priority}
          onChange={(event) => set("priority", event.target.value as TaskPriority)}
        >
          {TASK_PRIORITIES.map((priority) => (
            <option key={priority} value={priority}>
              {priority}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor={`${idPrefix}-list`}>Task List</label>
        <select
          id={`${idPrefix}-list`}
          value={values.listId}
          onChange={(event) => set("listId", event.target.value)}
        >
          {lists.map((list) => (
            <option key={list.id} value={list.id}>
              {list.name}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor={`${idPrefix}-responsible`}>Responsible Person</label>
        <select
          id={`${idPrefix}-responsible`}
          value={values.responsible}
          onChange={(event) => set("responsible", event.target.value)}
        >
          <option value={OWNER_VALUE}>You</option>
          <option value={NOBODY_VALUE}>Nobody</option>
          {profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.fullName ?? profile.id}
            </option>
          ))}
        </select>
        <p className="field-hint">
          Responsibility only. Nobody is granted access and nobody is notified.
        </p>
      </div>
    </div>
  );
}

/** One Task in a list, with its controls and its own edit form. */
function TaskRow({
  task,
  lists,
  profiles,
  busy,
  onComplete,
  onReopen,
  onSave,
  onTrash,
  onLink,
  sourceAvailable,
}: {
  task: Task;
  lists: TaskList[];
  profiles: PersonProfile[];
  busy: boolean;
  onComplete: () => Promise<void>;
  onReopen: () => Promise<void>;
  onSave: (values: TaskFormValues) => Promise<boolean>;
  onTrash: () => Promise<void>;
  onLink: () => Promise<void>;
  /** False once what the Task was promoted from has been deleted. */
  sourceAvailable: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [values, setValues] = useState<TaskFormValues>(() => formValuesFrom(task));
  const editButton = useRef<HTMLButtonElement>(null);

  /* Focus returns to the control that opened the form, so a keyboard user is
     not dropped at the top of the document when the form closes. A saved edit
     is handled by the page instead: it can move the Task into a different
     due-date group, and this button is then a different element. */
  const close = useCallback(() => {
    setEditing(false);
    editButton.current?.focus();
  }, []);

  return (
    <li className="card" id={`task-${task.id}`}>
      <h3>{task.title}</h3>
      <p className="muted">
        {listName(lists, task.listId)} · {task.dueDate ? `due ${task.dueDate}` : "no due date"} ·{" "}
        {task.priority === "none" ? "no priority" : `${task.priority} priority`} ·{" "}
        {responsibleLabel(task.responsiblePerson, profiles)}
      </p>
      {task.notes && <p>{task.notes}</p>}
      {/* The Task links back to the Action Item's own surface, and says so
          honestly when what it came from is no longer there to open. */}
      {task.source && (
        <p className="muted">
          Promoted from a Meeting Debrief.{" "}
          {sourceAvailable ? (
            /* The Meeting Debrief is where an Action Item is read; it has no
               surface of its own to deep-link into yet. */
            <Link to={`/meeting-debrief/${encodeURIComponent(task.source.debriefRunId)}`}>
              Open the Action Item it came from
            </Link>
          ) : (
            /* The Task is a snapshot and outlived what proposed it. Saying so
               is the honest answer; a link into nothing is not. */
            "That Action Item is no longer available. This Task is unaffected."
          )}
        </p>
      )}
      {task.externalLink && (
        <p className="muted">
          {task.externalLink.state === "synchronized"
            ? "Sent to Google Tasks."
            : task.externalLink.state === "failed"
              ? `Google Tasks refused it: ${task.externalLink.failure ?? "no reason given"}`
              : "Waiting to reach Google Tasks."}{" "}
          {task.externalLink.url && (
            <a href={task.externalLink.url} target="_blank" rel="noreferrer">
              Open in Google Tasks
            </a>
          )}
        </p>
      )}
      <div className="toolbar">
        {task.status === "open" ? (
          <button
            type="button"
            className="action-button"
            aria-disabled={busy}
            onClick={() => void onComplete()}
          >
            Complete
          </button>
        ) : (
          <button
            type="button"
            className="action-button"
            aria-disabled={busy}
            onClick={() => void onReopen()}
          >
            Reopen
          </button>
        )}
        {task.destination.provider === "google-tasks" &&
          task.externalLink?.state !== "synchronized" && (
            <button
              type="button"
              className="action-button"
              aria-disabled={busy}
              onClick={() => void onLink()}
            >
              Send to Google Tasks
            </button>
          )}
        <button
          type="button"
          className="action-button"
          aria-disabled={busy}
          onClick={() => void onTrash()}
        >
          Move to Trash
        </button>
        <button
          type="button"
          className="action-button"
          id={`task-${task.id}-edit`}
          ref={editButton}
          aria-expanded={editing}
          onClick={() => {
            setValues(formValuesFrom(task));
            setEditing((open) => !open);
          }}
        >
          Edit details
        </button>
      </div>
      {editing && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void onSave(values).then((saved) => {
              if (saved) close();
            });
          }}
        >
          <div className="field-row">
            <label htmlFor={`task-${task.id}-title`}>Title</label>
            <input
              id={`task-${task.id}-title`}
              value={values.title}
              autoFocus
              onChange={(event) => setValues({ ...values, title: event.target.value })}
            />
          </div>
          <TaskFields
            idPrefix={`task-${task.id}`}
            values={values}
            lists={lists}
            profiles={profiles}
            onChange={setValues}
          />
          <div className="toolbar">
            <button type="submit" className="action-button primary" aria-disabled={busy}>
              Save details
            </button>
            <button type="button" className="action-button" onClick={close}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </li>
  );
}

/**
 * One pending Action Item, and the review that promotes it (issue #178).
 *
 * The panel is where a proposal becomes accepted work: every field is editable
 * before anything is created, and both buttons open the same panel — creating
 * a completed Task is the same decision about the same fields, made about work
 * the meeting already finished.
 */
function ActionItemRow({
  item,
  lists,
  profiles,
  busy,
  onPromote,
}: {
  item: ActionItem;
  lists: TaskList[];
  profiles: PersonProfile[];
  busy: boolean;
  onPromote: (values: TaskFormValues, completed: boolean) => Promise<boolean>;
}) {
  const [reviewing, setReviewing] = useState<"open" | "completed" | null>(null);
  const [values, setValues] = useState<TaskFormValues>({
    title: item.proposal.title,
    notes: item.proposal.notes,
    dueDate: item.proposal.dueDate ?? "",
    priority: "none",
    listId: INBOX_TASK_LIST_ID,
    responsible: responsibleValue(item.proposal.responsiblePerson),
  });
  return (
    <li className="card">
      <h3>{item.proposal.title}</h3>
      <p className="muted">
        Proposed · {item.proposal.dueDate ? `due ${item.proposal.dueDate}` : "no due date"} ·{" "}
        {responsibleLabel(item.proposal.responsiblePerson, profiles)}
        {item.evidence.responsibleSurfaceName
          ? ` · named ${item.evidence.responsibleSurfaceName}`
          : ""}
      </p>
      <p className="muted">
        From a Meeting Debrief.{" "}
        <Link to={`/meeting-debrief/${encodeURIComponent(item.source.debriefRunId)}`}>
          Open full Debrief
        </Link>
      </p>
      {item.state === "promoted" && item.promotedTaskId && (
        <p className="muted">
          Promoted. <Link to={`/tasks#task-${item.promotedTaskId}`}>Open the Task</Link>
        </p>
      )}
      {item.state === "pending" && (
        <div className="toolbar">
          <button
            type="button"
            className="action-button"
            aria-expanded={reviewing === "open"}
            onClick={() => setReviewing(reviewing === "open" ? null : "open")}
          >
            Create Task
          </button>
          <button
            type="button"
            className="action-button"
            aria-expanded={reviewing === "completed"}
            onClick={() => setReviewing(reviewing === "completed" ? null : "completed")}
          >
            Create completed Task
          </button>
        </div>
      )}
      {reviewing && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void onPromote(values, reviewing === "completed").then((promoted) => {
              if (promoted) setReviewing(null);
            });
          }}
        >
          <div className="field-row">
            <label htmlFor={`action-item-${item.id}-title`}>Title</label>
            <input
              id={`action-item-${item.id}-title`}
              value={values.title}
              autoFocus
              onChange={(event) => setValues({ ...values, title: event.target.value })}
            />
          </div>
          <TaskFields
            idPrefix={`action-item-${item.id}`}
            values={values}
            lists={lists}
            profiles={profiles}
            onChange={setValues}
          />
          <div className="toolbar">
            <button type="submit" className="action-button primary" aria-disabled={busy}>
              {reviewing === "completed" ? "Create completed Task" : "Create Task"}
            </button>
            <button type="button" className="action-button" onClick={() => setReviewing(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </li>
  );
}

/** One trashed Task, with the two operations only Trash offers. */
function TrashRow({
  task,
  busy,
  onRestore,
  onDeleteForever,
}: {
  task: Task;
  busy: boolean;
  onRestore: () => Promise<void>;
  onDeleteForever: () => Promise<void>;
}) {
  /* Two presses rather than a browser dialog: permanent deletion is the one
     Task operation with nothing behind it, and confirming it has to be a
     deliberate act on this screen rather than a reflex on a modal. */
  const [confirming, setConfirming] = useState(false);
  return (
    <li className="card">
      <h3>{task.title}</h3>
      <p className="muted">
        In Trash · was {task.status} · restoring returns it exactly as it was.
      </p>
      <div className="toolbar">
        <button
          type="button"
          className="action-button"
          aria-disabled={busy}
          onClick={() => void onRestore()}
        >
          Restore
        </button>
        {confirming ? (
          <>
            <button
              type="button"
              className="action-button primary"
              aria-disabled={busy}
              onClick={() => void onDeleteForever()}
            >
              Yes, delete {task.title} forever
            </button>
            <button type="button" className="action-button" onClick={() => setConfirming(false)}>
              Keep it
            </button>
          </>
        ) : (
          <button type="button" className="action-button" onClick={() => setConfirming(true)}>
            Delete forever
          </button>
        )}
      </div>
    </li>
  );
}

export function TasksPage({
  client = tasksApi,
  people = peopleApi,
}: {
  client?: TasksClient;
  people?: PeopleClient;
}) {
  useTitle("Tasks");
  const focusRef = usePageFocus<HTMLHeadingElement>();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [trash, setTrash] = useState<Task[]>([]);
  const [unavailableSources, setUnavailableSources] = useState<string[]>([]);
  /** Which Task's edit control should take focus back after a save. */
  const [focusTaskId, setFocusTaskId] = useState<string | null>(null);
  const [today, setToday] = useState("");
  const [lists, setLists] = useState<TaskList[]>([]);
  const [pending, setPending] = useState<ActionItem[]>([]);
  const [destination, setDestination] = useState<GoogleTasksDestination | null>(null);
  const [googleLists, setGoogleLists] = useState<{ id: string; title: string }[]>([]);
  /* The filters, held as one value so the load below is a function of them
     rather than of five pieces of state that can disagree. */
  const [filters, setFilters] = useState({
    search: "",
    listId: "",
    priority: "",
    responsible: "",
    linked: "",
  });
  const [profiles, setProfiles] = useState<PersonProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [quickTitle, setQuickTitle] = useState("");
  const [quickOpen, setQuickOpen] = useState(false);
  const [quickValues, setQuickValues] = useState<TaskFormValues>({
    title: "",
    notes: "",
    dueDate: "",
    priority: "none",
    listId: INBOX_TASK_LIST_ID,
    responsible: OWNER_VALUE,
  });
  const quickInput = useRef<HTMLInputElement>(null);
  const [newListName, setNewListName] = useState("");

  /** What the page shows: the filtered Tasks, Trash, and the Action Items. */
  const load = useCallback(async () => {
    const [index, trashed, queue] = await Promise.all([
      client.tasks({
        ...(filters.search ? { search: filters.search } : {}),
        ...(filters.listId ? { listId: filters.listId } : {}),
        ...(filters.priority ? { priority: filters.priority } : {}),
        ...(filters.responsible ? { responsible: filters.responsible } : {}),
        ...(filters.linked ? { linked: filters.linked === "linked" } : {}),
      }),
      client.tasks({ trashed: true }),
      client.actionItems(),
    ]);
    setTasks(index.tasks);
    setLists(index.lists);
    setToday(index.today);
    setUnavailableSources(index.unavailableSources);
    setTrash(trashed.tasks);
    setPending(queue.items);
  }, [client, filters]);

  useEffect(() => {
    let live = true;
    Promise.all([load(), people.people(), client.googleDestination()])
      .then(([, directory, googleDestination]) => {
        if (!live) return;
        /* The same test the Workspace applies: offering a Profile it would
           refuse turns a chooser into a way to earn a 400. */
        setProfiles(
          directory.filter(
            (profile) => profile.archivedAt === null && profile.mergedInto === undefined,
          ),
        );
        setDestination(googleDestination);
      })
      .catch((err) => {
        if (live) setError(errorMessage(err));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [client, people, load]);

  /* A saved edit can move a Task into a different due-date group, which
     re-parents its row and replaces the button that was focused. Focus is
     therefore restored here, once the redrawn list is in the document, rather
     than by the row that no longer exists. */
  useEffect(() => {
    if (focusTaskId === null) return;
    document.getElementById(`task-${focusTaskId}-edit`)?.focus();
    setFocusTaskId(null);
  }, [focusTaskId, tasks]);

  /**
   * One place where a Workspace write and its consequences meet: the action
   * runs, the page reloads what it shows, and a refusal becomes a message
   * rather than a silently unchanged screen.
   */
  const act = useCallback(
    async (announce: string, action: () => Promise<unknown>): Promise<boolean> => {
      if (busy) return false;
      setBusy(true);
      setError(null);
      try {
        await action();
        await load();
        setNotice(announce);
        return true;
      } catch (err) {
        setError(errorMessage(err));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [busy, load],
  );

  async function quickAdd(event: React.FormEvent) {
    event.preventDefault();
    const title = quickOpen ? quickValues.title : quickTitle;
    const added = await act(`Added ${title.trim()}.`, () =>
      client.createTask(
        quickOpen
          ? {
              title: quickValues.title,
              notes: quickValues.notes,
              dueDate: quickValues.dueDate === "" ? null : quickValues.dueDate,
              priority: quickValues.priority,
              listId: quickValues.listId,
              responsiblePerson: responsibleFromValue(quickValues.responsible),
            }
          : { title },
      ),
    );
    if (!added) return;
    setQuickTitle("");
    setQuickValues({
      title: "",
      notes: "",
      dueDate: "",
      priority: "none",
      listId: INBOX_TASK_LIST_ID,
      responsible: OWNER_VALUE,
    });
    quickInput.current?.focus();
  }

  /* Open and Completed differ by which Tasks they hold, not by what a Task
     row can do — a completed Task is reopened and edited exactly like an open
     one, so both sections render through here. */
  const renderTask = (task: Task) => (
    <TaskRow
      key={task.id}
      task={task}
      lists={lists}
      profiles={profiles}
      busy={busy}
      onComplete={async () => {
        await act(`Completed ${task.title}.`, () => client.completeTask(task.id));
      }}
      onReopen={async () => {
        await act(`Reopened ${task.title}.`, () => client.reopenTask(task.id));
      }}
      sourceAvailable={!unavailableSources.includes(task.id)}
      onTrash={async () => {
        await act(`Moved ${task.title} to Trash.`, () => client.trashTask(task.id));
      }}
      onLink={async () => {
        await act(`Sent ${task.title} to Google Tasks.`, () => client.linkTask(task.id));
      }}
      onSave={async (values) => {
        const saved = await act(`Saved ${values.title.trim()}.`, () =>
          client.updateTask(task.id, {
            title: values.title,
            notes: values.notes,
            dueDate: values.dueDate === "" ? null : values.dueDate,
            priority: values.priority,
            listId: values.listId,
            responsiblePerson: responsibleFromValue(values.responsible),
          }),
        );
        /* Only once the redrawn list has landed: asking for focus before the
           reload would hand it to a row the reload is about to replace. */
        if (saved) setFocusTaskId(task.id);
        return saved;
      }}
    />
  );

  const openGroups = groupTasks(
    tasks.filter((task) => task.status === "open"),
    today,
  );
  const openCount = TASK_GROUPS.reduce((total, group) => total + openGroups[group].length, 0);
  const filtered = Object.values(filters).some((value) => value !== "");
  const completed = tasks.filter((task) => task.status === "completed");

  return (
    <>
      <h1 ref={focusRef} tabIndex={-1}>
        Tasks
      </h1>
      <p className="muted">
        Every Task the Workspace owns, however it got here. Nothing on this page needs Google,
        Asana, or any other account.
      </p>

      {error && (
        <p className="banner-error" role="alert">
          {error}
        </p>
      )}
      <p className="visually-hidden" role="status">
        {notice ?? ""}
      </p>

      <form className="card" onSubmit={(event) => void quickAdd(event)}>
        <h2>Quick Add</h2>
        <div className="field-row">
          <label htmlFor="quick-add-title">Task title</label>
          <input
            id="quick-add-title"
            ref={quickInput}
            value={quickOpen ? quickValues.title : quickTitle}
            autoComplete="off"
            onChange={(event) =>
              quickOpen
                ? setQuickValues({ ...quickValues, title: event.target.value })
                : setQuickTitle(event.target.value)
            }
          />
          <button type="submit" className="action-button primary" aria-disabled={busy}>
            Add task
          </button>
        </div>
        <button
          type="button"
          className="action-button"
          aria-expanded={quickOpen}
          onClick={() => {
            setQuickValues({ ...quickValues, title: quickOpen ? quickValues.title : quickTitle });
            setQuickTitle(quickOpen ? quickValues.title : quickTitle);
            setQuickOpen((shown) => !shown);
          }}
        >
          {quickOpen ? "Hide details" : "Add details"}
        </button>
        {quickOpen && (
          <TaskFields
            idPrefix="quick-add"
            values={quickValues}
            lists={lists}
            profiles={profiles}
            onChange={setQuickValues}
          />
        )}
      </form>

      <h2>Open</h2>
      {/* Grouped by due date in the Workspace timezone, which the server
          resolves and serves: a date-only due date belongs to the owner's own
          day rather than to the browser's. */}
      <form className="card" onSubmit={(event) => event.preventDefault()}>
        <div className="field-row">
          <label htmlFor="task-search">Search Tasks</label>
          <input
            id="task-search"
            type="search"
            value={filters.search}
            autoComplete="off"
            onChange={(event) => setFilters({ ...filters, search: event.target.value })}
          />
        </div>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="filter-list">Filter by Task List</label>
            <select
              id="filter-list"
              value={filters.listId}
              onChange={(event) => setFilters({ ...filters, listId: event.target.value })}
            >
              <option value="">Every list</option>
              {lists.map((list) => (
                <option key={list.id} value={list.id}>
                  {list.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="filter-priority">Filter by priority</label>
            <select
              id="filter-priority"
              value={filters.priority}
              onChange={(event) => setFilters({ ...filters, priority: event.target.value })}
            >
              <option value="">Any priority</option>
              {TASK_PRIORITIES.map((priority) => (
                <option key={priority} value={priority}>
                  {priority}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="filter-responsible">Filter by Responsible Person</label>
            <select
              id="filter-responsible"
              value={filters.responsible}
              onChange={(event) => setFilters({ ...filters, responsible: event.target.value })}
            >
              <option value="">Anyone</option>
              <option value="owner">You</option>
              <option value="nobody">Nobody</option>
              {profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.fullName ?? profile.id}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="filter-linked">Filter by External Task Link</label>
            <select
              id="filter-linked"
              value={filters.linked}
              onChange={(event) => setFilters({ ...filters, linked: event.target.value })}
            >
              <option value="">Linked or not</option>
              <option value="linked">Linked</option>
              <option value="unlinked">Not linked</option>
            </select>
          </div>
        </div>
      </form>
      {loading && <p className="muted">Loading…</p>}
      {/* Two empty states, because they mean different things: a Workspace
          with no open work at all, and a filter that happens to exclude all of
          it. Telling someone they have no Tasks while a filter is on would be
          untrue. */}
      {!loading &&
        openCount === 0 &&
        (filtered ? (
          <p className="muted">No open Tasks match those filters.</p>
        ) : (
          <p className="muted">No open Tasks. Quick Add above captures one.</p>
        ))}
      {TASK_GROUPS.map((group) =>
        openGroups[group].length === 0 ? null : (
          <section key={group}>
            <h3>{TASK_GROUP_LABELS[group]}</h3>
            <ul className="card-list">{openGroups[group].map(renderTask)}</ul>
          </section>
        ),
      )}

      <h2>Action Items</h2>
      <p className="muted">
        Commitments a Meeting Debrief proposed. A proposal is not a Task, and nothing here has been
        accepted.
      </p>
      {!loading && pending.length === 0 && <p className="muted">No Action Items are waiting.</p>}
      <ul className="card-list">
        {pending.map((item) => (
          <ActionItemRow
            key={item.id}
            item={item}
            lists={lists}
            profiles={profiles}
            busy={busy}
            onPromote={(values, completed) =>
              act(`Created ${values.title.trim()}.`, () =>
                client.promoteActionItem(item.id, {
                  title: values.title,
                  notes: values.notes,
                  dueDate: values.dueDate === "" ? null : values.dueDate,
                  priority: values.priority,
                  listId: values.listId,
                  responsiblePerson: responsibleFromValue(values.responsible),
                  completed,
                }),
              )
            }
          />
        ))}
      </ul>

      <h2>Trash</h2>
      <p className="muted">
        Nothing here is gone. Restoring returns a Task to the state it was in; deleting one forever
        cannot be undone.
      </p>
      {!loading && trash.length === 0 && <p className="muted">Trash is empty.</p>}
      <ul className="card-list">
        {trash.map((task) => (
          <TrashRow
            key={task.id}
            task={task}
            busy={busy}
            onRestore={async () => {
              await act(`Restored ${task.title}.`, () => client.restoreTask(task.id));
            }}
            onDeleteForever={async () => {
              await act(`Deleted ${task.title} forever.`, () => client.deleteTaskForever(task.id));
            }}
          />
        ))}
      </ul>

      <h2>Completed</h2>
      {!loading && completed.length === 0 && <p className="muted">Nothing completed yet.</p>}
      <ul className="card-list">{completed.map(renderTask)}</ul>

      <h2>Task Destination</h2>
      <p className="muted">
        Google Tasks is optional. Everything above works without it, and enabling it asks Google for
        one extra permission — the only thing that permission is used for is creating the Tasks you
        send.
      </p>
      {destination && (
        <div className="card">
          <p className="muted">
            {destination.enabled
              ? `Enabled · new Tasks can be created in ${destination.taskListTitle}`
              : "Not enabled · every Task stays in this Workspace"}
          </p>
          <div className="field-row">
            <label htmlFor="google-task-list">Google Task List</label>
            <select
              id="google-task-list"
              value={destination.taskListId}
              onChange={(event) =>
                setDestination({ ...destination, taskListId: event.target.value })
              }
            >
              <option value="">Choose a list</option>
              {googleLists.map((list) => (
                <option key={list.id} value={list.id}>
                  {list.title}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="action-button"
              aria-disabled={busy}
              onClick={() => {
                void act("Read the Google Task Lists.", async () => {
                  setGoogleLists((await client.googleLists()).lists);
                });
              }}
            >
              Load lists from Google
            </button>
          </div>
          <div className="toolbar">
            <button
              type="button"
              className="action-button primary"
              aria-disabled={busy}
              onClick={() => {
                void act("Saved the Task Destination.", async () => {
                  setDestination(
                    await client.setGoogleDestination({
                      enabled: !destination.enabled,
                      taskListId: destination.taskListId,
                    }),
                  );
                });
              }}
            >
              {destination.enabled ? "Disable Google Tasks" : "Enable Google Tasks"}
            </button>
          </div>
        </div>
      )}

      <h2>Task Lists</h2>
      <p className="muted">
        Every Task belongs to exactly one list. Inbox always exists and holds anything you do not
        file elsewhere.
      </p>
      <ul className="card-list">
        {lists.map((list) => (
          <TaskListRow
            key={list.id}
            list={list}
            count={tasks.filter((task) => task.listId === list.id).length}
            busy={busy}
            onRename={(name) =>
              act(`Renamed the list to ${name}.`, () => client.renameTaskList(list.id, name))
            }
            onDelete={() =>
              act(`Deleted the list ${list.name}.`, () => client.deleteTaskList(list.id))
            }
          />
        ))}
      </ul>
      <form
        className="card"
        onSubmit={(event) => {
          event.preventDefault();
          void act(`Created the list ${newListName.trim()}.`, () =>
            client.createTaskList(newListName),
          ).then((created) => {
            if (created) setNewListName("");
          });
        }}
      >
        <div className="field-row">
          <label htmlFor="new-task-list">New Task List</label>
          <input
            id="new-task-list"
            value={newListName}
            autoComplete="off"
            onChange={(event) => setNewListName(event.target.value)}
          />
          <button type="submit" className="action-button" aria-disabled={busy}>
            Create list
          </button>
        </div>
      </form>
    </>
  );
}

/** One Task List, with the two operations Inbox does not have. */
function TaskListRow({
  list,
  count,
  busy,
  onRename,
  onDelete,
}: {
  list: TaskList;
  count: number;
  busy: boolean;
  onRename: (name: string) => Promise<boolean>;
  onDelete: () => Promise<boolean>;
}) {
  const [name, setName] = useState(list.name);
  const permanent = list.id === INBOX_TASK_LIST_ID;
  return (
    <li className="card">
      <h3>{list.name}</h3>
      <p className="muted">
        {count} Task{count === 1 ? "" : "s"} · destination: {list.defaultDestination.provider}
        {permanent ? " · always exists" : ""}
      </p>
      {!permanent && (
        <form
          className="field-row"
          onSubmit={(event) => {
            event.preventDefault();
            void onRename(name);
          }}
        >
          <label htmlFor={`list-${list.id}-name`}>Name</label>
          <input
            id={`list-${list.id}-name`}
            value={name}
            autoComplete="off"
            onChange={(event) => setName(event.target.value)}
          />
          <button type="submit" className="action-button" aria-disabled={busy}>
            Rename
          </button>
          <button
            type="button"
            className="action-button"
            aria-disabled={busy}
            onClick={() => void onDelete()}
          >
            Delete list
          </button>
        </form>
      )}
    </li>
  );
}
