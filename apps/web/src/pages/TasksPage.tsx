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
import { INBOX_TASK_LIST_ID, TASK_PRIORITIES } from "@chief-of-staff-demo/shared";
import { errorMessage } from "../client";
import { tasksApi, type TasksClient } from "../clients/tasks";
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
}: {
  task: Task;
  lists: TaskList[];
  profiles: PersonProfile[];
  busy: boolean;
  onComplete: () => Promise<void>;
  onReopen: () => Promise<void>;
  onSave: (values: TaskFormValues) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [values, setValues] = useState<TaskFormValues>(() => formValuesFrom(task));
  const editButton = useRef<HTMLButtonElement>(null);

  /* Focus returns to the control that opened the form, so a keyboard user is
     not dropped at the top of the document when the form closes. */
  const close = useCallback(() => {
    setEditing(false);
    editButton.current?.focus();
  }, []);

  return (
    <li className="card">
      <h3>{task.title}</h3>
      <p className="muted">
        {listName(lists, task.listId)} · {task.dueDate ? `due ${task.dueDate}` : "no due date"} ·{" "}
        {task.priority === "none" ? "no priority" : `${task.priority} priority`} ·{" "}
        {responsibleLabel(task.responsiblePerson, profiles)}
      </p>
      {task.notes && <p>{task.notes}</p>}
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
        <button
          type="button"
          className="action-button"
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

/** One pending Action Item: a proposal, shown as one, with no Task controls. */
function ActionItemRow({ item, profiles }: { item: ActionItem; profiles: PersonProfile[] }) {
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
  const [lists, setLists] = useState<TaskList[]>([]);
  const [pending, setPending] = useState<ActionItem[]>([]);
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

  const load = useCallback(async () => {
    const [index, queue] = await Promise.all([client.tasks(), client.actionItems("pending")]);
    setTasks(index.tasks);
    setLists(index.lists);
    setPending(queue.items);
  }, [client]);

  useEffect(() => {
    let live = true;
    Promise.all([client.tasks(), client.actionItems("pending"), people.people()])
      .then(([index, queue, directory]) => {
        if (!live) return;
        setTasks(index.tasks);
        setLists(index.lists);
        setPending(queue.items);
        /* The same test the Workspace applies: offering a Profile it would
           refuse turns a chooser into a way to earn a 400. */
        setProfiles(
          directory.filter(
            (profile) => profile.archivedAt === null && profile.mergedInto === undefined,
          ),
        );
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
  }, [client, people]);

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
      onSave={(values) =>
        act(`Saved ${values.title.trim()}.`, () =>
          client.updateTask(task.id, {
            title: values.title,
            notes: values.notes,
            dueDate: values.dueDate === "" ? null : values.dueDate,
            priority: values.priority,
            listId: values.listId,
            responsiblePerson: responsibleFromValue(values.responsible),
          }),
        )
      }
    />
  );

  const open = tasks.filter((task) => task.status === "open");
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
      {loading && <p className="muted">Loading…</p>}
      {!loading && open.length === 0 && (
        <p className="muted">No open Tasks. Quick Add above captures one.</p>
      )}
      <ul className="card-list">{open.map(renderTask)}</ul>

      <h2>Action Items</h2>
      <p className="muted">
        Commitments a Meeting Debrief proposed. A proposal is not a Task, and nothing here has been
        accepted.
      </p>
      {!loading && pending.length === 0 && <p className="muted">No Action Items are waiting.</p>}
      <ul className="card-list">
        {pending.map((item) => (
          <ActionItemRow key={item.id} item={item} profiles={profiles} />
        ))}
      </ul>

      <h2>Completed</h2>
      {!loading && completed.length === 0 && <p className="muted">Nothing completed yet.</p>}
      <ul className="card-list">{completed.map(renderTask)}</ul>

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
