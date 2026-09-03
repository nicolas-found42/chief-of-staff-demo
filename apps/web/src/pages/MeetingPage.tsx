import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { Meeting, MeetingIneligibility } from "@chief-of-staff-demo/shared";
import { api, errorMessage } from "../client";
import { usePageFocus } from "../usePageFocus";
import { useTitle } from "../useTitle";

/** Why this Meeting earns no Meeting Brief, said the way a person would say it. */
const INELIGIBILITY_LABELS: Record<MeetingIneligibility, string> = {
  all_day_excluded: "This is an all-day entry, so there is nothing to prepare for a time.",
  missing_time: "Calendar gave this entry no start or end time.",
  cancelled: "Calendar reports this occurrence as cancelled.",
  owner_declined: "You declined this meeting.",
  no_other_attendee: "Nobody else was invited, or everybody else declined.",
};

const RESPONSE_LABELS: Record<Meeting["participants"][number]["responseStatus"], string> = {
  accepted: "Accepted",
  tentative: "Tentative",
  needsAction: "No reply",
  declined: "Declined",
};

/**
 * One Meeting's page (ADR-0050): the durable record, addressed by the
 * Meeting's own identity rather than by a Calendar occurrence key, because a
 * Meeting may have no occurrence at all.
 */
export function MeetingPage() {
  const { meetingId } = useParams<{ meetingId: string }>();
  const [meeting, setMeeting] = useState<Meeting | null>(null);
  const [transcripts, setTranscripts] = useState<{ id: string; title: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const headingRef = usePageFocus<HTMLHeadingElement>();
  useTitle(meeting ? meeting.title : "Meeting");

  useEffect(() => {
    if (!meetingId) return;
    let cancelled = false;
    api
      .meeting(meetingId)
      .then((result) => {
        if (!cancelled) setMeeting(result);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(errorMessage(cause));
      });
    api
      .meetingTranscripts(meetingId)
      .then((result) => {
        if (!cancelled) setTranscripts(result.transcripts);
      })
      .catch(() => {
        if (!cancelled) setTranscripts([]);
      });
    return () => {
      cancelled = true;
    };
  }, [meetingId]);

  if (error) {
    return (
      <div className="page">
        <h1 ref={headingRef} tabIndex={-1}>
          Meeting
        </h1>
        <div className="banner banner-error" role="alert">
          {error}
        </div>
        <p>
          <Link to="/meetings">Back to the Meeting Wizard</Link>
        </p>
      </div>
    );
  }

  if (!meeting) {
    return (
      <div className="page">
        <h1 ref={headingRef} tabIndex={-1}>
          Meeting
        </h1>
        <p className="muted" role="status">
          Loading meeting…
        </p>
      </div>
    );
  }

  return (
    <div className="page">
      <h1 ref={headingRef} tabIndex={-1}>
        {meeting.title}
      </h1>
      <p className="muted">
        <time dateTime={meeting.startAt}>{new Date(meeting.startAt).toLocaleString()}</time>
        {" — "}
        <time dateTime={meeting.endAt}>{new Date(meeting.endAt).toLocaleTimeString()}</time>
        {meeting.cancelled ? (
          <>
            {" · "}
            <span className="status-badge status-active">Cancelled</span>
          </>
        ) : null}
      </p>

      {meeting.ineligibleReason ? (
        <p className="muted">{INELIGIBILITY_LABELS[meeting.ineligibleReason]}</p>
      ) : null}

      <section aria-labelledby="meeting-participants-heading">
        <h2 id="meeting-participants-heading">Participants</h2>
        {meeting.participants.length === 0 ? (
          <p className="muted">Calendar listed no participants for this meeting.</p>
        ) : (
          <ul className="card-list">
            {meeting.participants.map((participant) => (
              <li key={participant.email} className="card">
                <h3>{participant.displayName ?? participant.email}</h3>
                <p>
                  <span className="muted">{participant.email}</span>
                  {" · "}
                  {RESPONSE_LABELS[participant.responseStatus]}
                  {participant.organizer ? " · Organizer" : ""}
                  {participant.self ? " · You" : ""}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="meeting-transcripts-heading">
        <h2 id="meeting-transcripts-heading">Transcripts</h2>
        {!transcripts ? (
          <p className="muted" role="status">
            Loading transcripts…
          </p>
        ) : transcripts.length === 0 ? (
          <p className="muted">No transcript matched yet.</p>
        ) : (
          <ul className="card-list">
            {transcripts.map((transcript) => (
              <li key={transcript.id} className="card">
                <h3>{transcript.title}</h3>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p>
        <Link to="/meetings">Back to the Meeting Wizard</Link>
      </p>
    </div>
  );
}
