import { useEffect, useState } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import type { ActionItemIndex } from "@chief-of-staff-demo/shared";
import { currentReconciliation } from "@chief-of-staff-demo/shared";
import { tasksApi } from "../clients/tasks";
import { errorMessage } from "../client";
import { MeetingActionItems } from "../components/MeetingActionItems";
import { usePageFocus } from "../usePageFocus";
import { useTitle } from "../useTitle";

/** A retained source scope remains reviewable even after its Meeting or Debrief disappears. */
export function MeetingRecoveryPage() {
  const { runId = "" } = useParams<{ runId: string }>();
  const [index, setIndex] = useState<ActionItemIndex | null>(null);
  const [error, setError] = useState<string | null>(null);
  const heading = usePageFocus<HTMLHeadingElement>();
  useTitle("Retained Meeting proposals");
  useEffect(() => {
    let live = true;
    setIndex(null);
    setError(null);
    void tasksApi
      .actionItems({ debriefRunId: runId })
      .then((result) => {
        if (live) setIndex(result);
      })
      .catch((cause: unknown) => {
        if (live) setError(errorMessage(cause));
      });
    return () => {
      live = false;
    };
  }, [runId]);
  /* Redirect only when every canonical Action Item in the run resolves to the
     same current Meeting, and no retained or unresolved relationship keeps the
     run-scoped view authoritative. A source that is unavailable does not
     redirect even though a Transcript may later carry a different Meeting. */
  const meeting =
    index &&
    index.items.length > 0 &&
    !index.items.some(
      (item) =>
        currentReconciliation(item)?.disposition === "unresolved" || item.reconciledInto !== null,
    ) &&
    index.items
      .map((item) => index.context?.[item.id]?.meeting ?? null)
      .every(
        (current): current is NonNullable<typeof current> =>
          current !== null && current.id === index.context?.[index.items[0]!.id]?.meeting?.id,
      )
      ? index.context?.[index.items[0]!.id]?.meeting
      : null;
  if (meeting)
    return (
      <Navigate
        replace
        to={`/meetings/${encodeURIComponent(meeting.id)}?tab=debrief#action-items`}
      />
    );
  return (
    <div className="page">
      <h1 ref={heading} tabIndex={-1}>
        Retained Meeting proposals
      </h1>
      <p>
        <Link to="/meetings#awaiting-approval">Back to Meetings</Link>
      </p>
      {error ? (
        <p role="alert">{error}</p>
      ) : !index ? (
        <p role="status">Loading source context…</p>
      ) : (
        <>
          <p>
            The original Meeting context is unavailable. These retained proposals preserve their
            original source identity and review decisions.
          </p>
          <p>
            {/* The explicit retained context tells the standalone Debrief to
                stay bound to this run-scoped review, never to redirect into a
                current Meeting that cannot count these canonical records. */}
            <Link to={`/meeting-debrief/${encodeURIComponent(runId)}?retained=1`}>
              Try the retained Debrief
            </Link>
          </p>
          <h2>Retained proposals</h2>
          {index.items.length ? (
            <MeetingActionItems key={runId} meetingId={null} runId={runId} />
          ) : (
            <p>No retained proposals were found for this source.</p>
          )}
        </>
      )}
    </div>
  );
}
