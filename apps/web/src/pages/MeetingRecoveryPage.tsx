import { useEffect, useState } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import type { ActionItemIndex } from "@chief-of-staff-demo/shared";
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
  const meeting =
    index && Object.values(index.context ?? {}).find((context) => context.meeting)?.meeting;
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
            <Link to={`/meeting-debrief/${encodeURIComponent(runId)}`}>
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
