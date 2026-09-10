import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import type {
  ActionItem,
  ActionItemIndex,
  PersonProfile,
  TaskIndex,
} from "@chief-of-staff-demo/shared";
import { tasksApi } from "../clients/tasks";
import { peopleApi } from "../clients/people";
import { errorMessage } from "../client";
import { ReadingDisclosure } from "./ReadingDisclosure";
import { ActionItemRow } from "./ActionItemReview";
import { responsibleFromValue } from "./taskReviewFields";

/** Meeting Wizard delegates each review decision to the canonical Tasks API. */
export function MeetingActionItems({
  meetingId,
  runId,
  regeneration,
  onCount,
  revealRequest = 0,
}: {
  meetingId: string | null;
  runId: string;
  regeneration?: ReactNode;
  revealRequest?: number;
  onCount?: (count: number) => void;
}) {
  const focusedAnchor = useRef("");
  const [index, setIndex] = useState<ActionItemIndex | null>(null);
  const [tasks, setTasks] = useState<TaskIndex | null>(null);
  const [profiles, setProfiles] = useState<PersonProfile[]>([]);
  const [expanded, setExpanded] = useState(
    () => sessionStorage.getItem(`actions:${runId}`) === "all",
  );
  const [busy, setBusy] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<ActionItem | null>(null);
  const announcement = useRef<HTMLParagraphElement>(null);
  const undo = useRef<HTMLButtonElement>(null);
  const seen = useRef<Set<string> | null>(null);
  const [newIds, setNewIds] = useState<string[]>([]);
  // Version changes and explicit review refreshes supersede slower reads (#327).
  const readGeneration = useRef(0);
  const reading = useRef(false);
  const inFlight = useRef(new Set<string>());
  const load = useCallback(async () => {
    const generation = ++readGeneration.current;
    reading.current = true;
    const result = await tasksApi
      .actionItems(meetingId ? { meetingId } : { debriefRunId: runId })
      .finally(() => {
        if (generation === readGeneration.current) reading.current = false;
      });
    if (generation !== readGeneration.current) return;
    if (seen.current) {
      const additions = result.items
        .filter((item) => !seen.current!.has(item.id))
        .map((item) => item.id);
      if (additions.length) {
        setNewIds((previous) => [...previous, ...additions]);
        setMessage(
          `${additions.length} new Action Items. Existing Tasks and review decisions are preserved.`,
        );
      }
    }
    seen.current = new Set(result.items.map((item) => item.id));
    onCount?.(result.items.length);
    setIndex(result);
  }, [meetingId, runId, onCount]);
  useEffect(() => {
    void load().catch((cause: unknown) => setError(errorMessage(cause)));
    void tasksApi
      .tasks()
      .then(setTasks)
      .catch((cause: unknown) => setError(errorMessage(cause)));
    void peopleApi
      .people()
      .then(setProfiles)
      .catch(() => setProfiles([]));
    const timer = window.setInterval(() => {
      if (!reading.current) void load().catch(() => {});
    }, 3000);
    const invalidate = () => {
      readGeneration.current++;
    };
    return () => {
      invalidate();
      window.clearInterval(timer);
    };
  }, [load]);
  useEffect(() => {
    if (dismissed) undo.current?.focus();
  }, [dismissed]);
  useEffect(() => {
    const reveal = () => {
      if (location.hash === "#action-items" || location.hash.startsWith("#action-item-")) {
        setExpanded(true);
        sessionStorage.setItem(`actions:${runId}`, "all");
      }
    };
    reveal();
    window.addEventListener("hashchange", reveal);
    return () => window.removeEventListener("hashchange", reveal);
  }, [runId]);
  useEffect(() => {
    if (revealRequest > 0) {
      setExpanded(true);
      sessionStorage.setItem(`actions:${runId}`, "all");
    }
  }, [revealRequest, runId]);
  useEffect(() => {
    if (!index || !tasks || !expanded || !location.hash.startsWith("#action-item-")) return;
    if (focusedAnchor.current === location.hash) return;
    const target = document.getElementById(location.hash.slice(1));
    if (target) {
      focusedAnchor.current = location.hash;
      target.tabIndex = -1;
      target.focus();
    }
  }, [index, tasks, expanded]);
  const act = async (id: string, notice: string, operation: () => Promise<unknown>) => {
    if (inFlight.current.has(id)) return false;
    inFlight.current.add(id);
    setBusy((ids) => [...ids, id]);
    setError(null);
    try {
      await operation();
      await load();
      await tasksApi
        .tasks()
        .then(setTasks)
        .catch(() => {});
      setMessage(notice);
      announcement.current?.focus({ preventScroll: true });
      return true;
    } catch (cause) {
      setError(errorMessage(cause));
      return false;
    } finally {
      inFlight.current.delete(id);
      setBusy((ids) => ids.filter((held) => held !== id));
    }
  };
  const restore = async (item: ActionItem) => {
    if (
      await act(item.id, `Restored ${item.proposal.title}.`, () =>
        tasksApi.restoreActionItem(item.id),
      )
    )
      setDismissed(null);
  };
  const pending = index?.items.filter((item) => item.state === "pending") ?? [];
  const reviewed = index?.items.filter((item) => item.state !== "pending") ?? [];
  return (
    <section tabIndex={-1} aria-labelledby="meeting-action-items-heading" id="action-items">
      <h3 id="meeting-action-items-heading">Action Items</h3>
      {regeneration}
      <p id="action-items-status" ref={announcement} tabIndex={-1} role="status">
        {message}
      </p>
      {error && <p role="alert">{error}</p>}
      {!index ? (
        <p>Loading Action Items…</p>
      ) : (
        <p className="muted">
          {pending.length} pending · {reviewed.length} reviewed
        </p>
      )}
      {dismissed && (
        <p>
          Dismissed {dismissed.proposal.title}.{" "}
          <button ref={undo} type="button" onClick={() => void restore(dismissed)}>
            Undo
          </button>
        </p>
      )}
      {index && pending.length === 0 && <p className="muted">No pending Action Items.</p>}
      {tasks && (
        <ul className="card-list">
          {(expanded ? pending : pending.slice(0, 5)).map((item) => (
            <ActionItemRow
              key={item.id}
              isNew={newIds.includes(item.id)}
              item={item}
              context={index?.context?.[item.id]}
              today={tasks.today}
              lists={tasks.lists}
              profiles={profiles}
              busy={busy.includes(item.id)}
              checkDuplicates={tasksApi.checkDuplicates}
              onPromote={(values, completed) =>
                act(
                  item.id,
                  `Created ${completed ? "completed Task" : "Task"}: ${values.title.trim()}.`,
                  () =>
                    tasksApi.promoteActionItem(item.id, {
                      title: values.title,
                      notes: values.notes,
                      dueDate: values.dueDate || null,
                      priority: values.priority,
                      listId: values.listId,
                      responsiblePerson: responsibleFromValue(values.responsible),
                      completed,
                    }),
                )
              }
              onDismiss={async () => {
                if (
                  await act(item.id, `Dismissed ${item.proposal.title}.`, () =>
                    tasksApi.dismissActionItem(item.id),
                  )
                )
                  setDismissed(item);
              }}
            />
          ))}
        </ul>
      )}
      {pending.length > 5 && (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => {
            sessionStorage.setItem(`actions:${runId}`, expanded ? "bounded" : "all");
            setExpanded(!expanded);
          }}
        >
          {expanded ? "Show fewer Action Items" : `Show all ${pending.length} pending Action Items`}
        </button>
      )}
      {reviewed.length > 0 && (
        <ReadingDisclosure
          id={`${runId}-reviewed`}
          label={`Reviewed Action Items (${reviewed.length})`}
          initialOpen={reviewed.some((item) => location.hash === `#action-item-${item.id}`)}
        >
          <ul>
            {reviewed.map((item) => (
              <li key={item.id} id={`action-item-${item.id}`}>
                {item.proposal.title} ·{" "}
                {item.state === "dismissed"
                  ? "Dismissed"
                  : tasks?.tasks.find((task) => task.id === item.promotedTaskId)?.status ===
                      "completed"
                    ? "Completed Task created"
                    : "Task created"}{" "}
                {item.handoff && (
                  <ReadingDisclosure id={`${item.id}-reviewed-details`} label="Execution details">
                    <p style={{ whiteSpace: "pre-wrap" }}>{item.proposal.notes}</p>
                  </ReadingDisclosure>
                )}
                {item.promotedTaskId ? (
                  <Link to={`/tasks#task-${item.promotedTaskId}`}>Open Task</Link>
                ) : (
                  <button type="button" onClick={() => void restore(item)}>
                    Restore to pending
                  </button>
                )}
              </li>
            ))}
          </ul>
        </ReadingDisclosure>
      )}
    </section>
  );
}
