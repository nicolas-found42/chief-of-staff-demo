import { ReadingDisclosure } from "./ReadingDisclosure";
import {
  OWNER_VALUE,
  NOBODY_VALUE,
  responsibleValue,
  responsibleFromValue,
  responsibleLabel,
  type TaskFormValues,
} from "./taskReviewFields";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type {
  ActionItem,
  ActionItemContext,
  PersonProfile,
  Task,
  TaskList,
  TaskPriority,
} from "@chief-of-staff-demo/shared";
import { INBOX_TASK_LIST_ID, TASK_PRIORITIES } from "@chief-of-staff-demo/shared";
import { meetingDate, proposedDue } from "../meetingDisplay";
import type { TasksClient } from "../clients/tasks";

/** The shared field set — the same in Quick Add's expansion and in an edit. */
export function TaskFields({
  idPrefix,
  values,
  lists,
  profiles,
  onChange,
  compact = false,
}: {
  compact?: boolean;
  idPrefix: string;
  values: TaskFormValues;
  lists: TaskList[];
  profiles: PersonProfile[];
  onChange: (values: TaskFormValues) => void;
}) {
  const set = <K extends keyof TaskFormValues>(key: K, value: TaskFormValues[K]) =>
    onChange({ ...values, [key]: value });
  const options = (
    <>
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
    </>
  );
  return (
    <div className="form-grid">
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
      {compact ? (
        <ReadingDisclosure id={`${idPrefix}-options`} label="More options">
          {options}
        </ReadingDisclosure>
      ) : (
        options
      )}
    </div>
  );
}

/**
 * The Possible duplicate warning (issue #180): the open Tasks a would-be Task
 * would duplicate, each linked. It is advisory by construction — the create
 * and promote routes take no confirmation token — so the form's next submit,
 * the one labeled "anyway", is the whole override mechanism.
 */
export function DuplicateWarning({ duplicates }: { duplicates: Task[] }) {
  return (
    <div className="banner banner-warn" role="status">
      <strong>Possible duplicate.</strong> An open Task already has this title, Responsible Person,
      and due date:{" "}
      {duplicates.map((duplicate) => (
        <details key={duplicate.id}>
          <summary>Compare: {duplicate.title}</summary>
          <p>
            {duplicate.listId === INBOX_TASK_LIST_ID ? "Inbox" : "Task List"} ·{" "}
            {duplicate.dueDate ? `due ${duplicate.dueDate}` : "no due date"} · {duplicate.status}
          </p>
          <p>{duplicate.notes || "No notes."}</p>
          <p>
            Responsible Person:{" "}
            {duplicate.responsiblePerson?.kind === "owner"
              ? "You"
              : (duplicate.responsiblePerson?.profileId ?? "Nobody")}
          </p>
        </details>
      ))}
      . Submit again to create the Task anyway.
    </div>
  );
}

/** The provider a Task's destination names, as the row's sentences read it. */
export function ActionItemRow({
  item,
  isNew = false,
  context,
  today,
  lists,
  profiles,
  busy,
  checkDuplicates,
  onPromote,
  onDismiss,
}: {
  item: ActionItem;
  isNew?: boolean;
  context: ActionItemContext | undefined;
  today: string;
  lists: TaskList[];
  profiles: PersonProfile[];
  busy: boolean;
  checkDuplicates: TasksClient["checkDuplicates"];
  onPromote: (values: TaskFormValues, completed: boolean) => Promise<boolean>;
  onDismiss: () => Promise<void>;
}) {
  const storageKey = `task-review:${item.id}`;
  const [saved] = useState(() => {
    try {
      return JSON.parse(sessionStorage.getItem(storageKey) ?? "null") as {
        reviewing: "open" | "completed";
        values: TaskFormValues;
      } | null;
    } catch {
      return null;
    }
  });
  const [reviewing, setReviewing] = useState<"open" | "completed" | null>(saved?.reviewing ?? null);
  const submitting = useRef(false);
  const [values, setValues] = useState<TaskFormValues>(
    saved?.values ?? {
      title: item.proposal.title,
      notes: item.proposal.notes,
      dueDate: item.proposal.dueDate ?? "",
      priority: "none",
      listId: INBOX_TASK_LIST_ID,
      responsible: responsibleValue(item.proposal.responsiblePerson),
    },
  );
  useEffect(() => {
    if (reviewing) sessionStorage.setItem(storageKey, JSON.stringify({ reviewing, values }));
    else sessionStorage.removeItem(storageKey);
  }, [storageKey, reviewing, values]);
  /* The Possible duplicate warning (issue #180). Its presence is the armed
     override: the next submit creates the Task, and any edit clears it. */
  const destination = lists.find((list) => list.id === values.listId)?.defaultDestination;
  const destinationLabel =
    !destination || destination.provider === "local"
      ? `Local only · ${lists.find((list) => list.id === values.listId)?.name ?? "Inbox"}`
      : destination.provider === "google-tasks"
        ? `Google Tasks · ${destination.googleTaskListTitle}`
        : `Asana · ${destination.projectName}${destination.sectionName ? ` · ${destination.sectionName}` : ""}`;
  const [duplicates, setDuplicates] = useState<Task[] | null>(null);

  /* Closing the panel drops its transient states with it: reopening is a
     fresh look at the proposal, not the old warning again. */
  const closeReview = () => {
    sessionStorage.removeItem(storageKey);
    const trigger = document.getElementById(`review-${item.id}-${reviewing}`);
    setReviewing(null);
    setDuplicates(null);
    trigger?.focus();
  };

  const edit = (next: TaskFormValues) => {
    setValues(next);
    setDuplicates(null);
  };

  async function submitReview() {
    if (submitting.current || busy) return;
    submitting.current = true;
    try {
      if (duplicates === null) {
        try {
          const check = await checkDuplicates({
            title: values.title,
            dueDate: values.dueDate === "" ? null : values.dueDate,
            responsiblePerson: responsibleFromValue(values.responsible),
          });
          if (check.duplicates.length > 0) {
            setDuplicates(check.duplicates);
            return;
          }
        } catch {
          /* An unanswerable check is not an objection. The warning is advisory,
           so when it cannot be produced the promotion proceeds exactly as it
           did before there was a check at all. */
        }
      }
      setDuplicates(null);
      if (await onPromote(values, reviewing === "completed")) closeReview();
    } finally {
      submitting.current = false;
    }
  }

  return (
    /* The anchor a compact surface links a proposal by (issue #192). */
    <li className="card" id={`action-item-${item.id}`}>
      <h3>{item.proposal.title}</h3>
      {isNew && <span aria-label="New proposal">New proposal</span>}
      <p className="muted">
        Proposed · {proposedDue(item.proposal.dueDate, today)} ·{" "}
        {item.proposal.responsiblePerson
          ? responsibleLabel(item.proposal.responsiblePerson, profiles)
          : "Unassigned"}
        {item.evidence.responsibleSurfaceName
          ? ` · named ${item.evidence.responsibleSurfaceName}`
          : ""}
      </p>
      <p className="muted">
        {context?.meeting ? (
          <>
            <Link to={`/meetings/${context.meeting.id}?tab=debrief`}>{context.meeting.title}</Link>{" "}
            · From {meetingDate(context.meeting.date)}.{" "}
          </>
        ) : (
          "Source Meeting unavailable. "
        )}
        <Link to={`/meeting-debrief/${encodeURIComponent(item.source.debriefRunId)}`}>
          Open source Debrief
        </Link>
      </p>
      <ReadingDisclosure id={`${item.id}-evidence`} label="Original evidence">
        {context?.evidence ? (
          <>
            <blockquote>{context.evidence.quote}</blockquote>
            {context.evidence.timestamp ? <p>At {context.evidence.timestamp}</p> : null}
          </>
        ) : (
          <p>
            Stored excerpt and timestamp unavailable. Open the source Debrief for the retained
            extraction.
          </p>
        )}
      </ReadingDisclosure>
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
            id={`review-${item.id}-open`}
            aria-expanded={reviewing === "open"}
            onClick={() => (reviewing === "open" ? closeReview() : setReviewing("open"))}
          >
            Create Task
          </button>
          <button
            type="button"
            className="action-button"
            id={`review-${item.id}-completed`}
            aria-expanded={reviewing === "completed"}
            onClick={() => (reviewing === "completed" ? closeReview() : setReviewing("completed"))}
          >
            Create completed Task
          </button>
          <button
            type="button"
            className="action-button"
            disabled={busy}
            onClick={() => {
              if (!busy) {
                sessionStorage.removeItem(storageKey);
                void onDismiss();
              }
            }}
          >
            Dismiss
          </button>
        </div>
      )}
      {reviewing && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submitReview();
          }}
        >
          <div className="field-row">
            <label htmlFor={`action-item-${item.id}-title`}>Title</label>
            <input
              id={`action-item-${item.id}-title`}
              value={values.title}
              autoFocus
              onChange={(event) => edit({ ...values, title: event.target.value })}
            />
          </div>
          <TaskFields
            compact
            idPrefix={`action-item-${item.id}`}
            values={values}
            lists={lists}
            profiles={profiles}
            onChange={edit}
          />
          <p>Task Destination: {destinationLabel}</p>
          {destination && destination.provider !== "local" && (
            <p className="muted">
              Creating this Task also sends its title, notes and due date to {destinationLabel}.
            </p>
          )}
          {duplicates && <DuplicateWarning duplicates={duplicates} />}
          <div className="toolbar">
            <button type="submit" className="action-button primary" aria-disabled={busy}>
              {reviewing === "completed"
                ? duplicates
                  ? "Create completed Task anyway"
                  : "Create completed Task"
                : duplicates
                  ? "Create Task anyway"
                  : "Create Task"}
            </button>
            <button type="button" className="action-button" onClick={closeReview}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </li>
  );
}
