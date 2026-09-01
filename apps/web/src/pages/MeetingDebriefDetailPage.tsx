import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { MeetingDebriefDetail } from "@chief-of-staff-demo/shared";
import { api, errorMessage } from "../client";
import { usePageFocus } from "../usePageFocus";
import { useTitle } from "../useTitle";

function ExtractionSection({ detail }: { detail: MeetingDebriefDetail }) {
  const debrief = detail.extraction;
  if (!debrief) {
    return (
      <section aria-labelledby="debrief-extraction">
        <h2 id="debrief-extraction">Extraction</h2>
        <p className="muted">No extraction yet — the Run is {detail.status}.</p>
      </section>
    );
  }
  return (
    <section aria-labelledby="debrief-extraction">
      <h2 id="debrief-extraction">Extraction</h2>
      <h3>Summary</h3>
      <p>{debrief.summary}</p>
      <h3>Decisions</h3>
      {debrief.decisions.length === 0 ? (
        <p className="muted">No decisions recorded.</p>
      ) : (
        <ul>
          {debrief.decisions.map((decision, index) => (
            <li key={index}>
              {decision.statement}
              {decision.evidence && <span className="muted"> — “{decision.evidence}”</span>}
            </li>
          ))}
        </ul>
      )}
      <h3>Action items</h3>
      {debrief.actionItems.length === 0 ? (
        <p className="muted">No action items.</p>
      ) : (
        <ul>
          {debrief.actionItems.map((item, index) => (
            <li key={index}>
              {item.title} — owner: {item.owner ?? "unassigned"}
              {item.ownerProfileId && (
                <>
                  {" "}
                  <Link to={`/people/${encodeURIComponent(item.ownerProfileId)}`}>
                    (confirmed Profile)
                  </Link>
                </>
              )}
              {!item.ownerProfileId && item.ownerMentionId && (
                <span className="muted"> (identity not confirmed)</span>
              )}
              {item.dueDate && <span className="muted"> — due {item.dueDate}</span>}
            </li>
          ))}
        </ul>
      )}
      <h3>Open questions</h3>
      {debrief.openQuestions.length === 0 ? (
        <p className="muted">None.</p>
      ) : (
        <ul>
          {debrief.openQuestions.map((question, index) => (
            <li key={index}>
              {question.question}
              {question.raisedBy && <span className="muted"> — raised by {question.raisedBy}</span>}
            </li>
          ))}
        </ul>
      )}
      <h3>Effectiveness evidence</h3>
      <p>{debrief.effectivenessEvidence}</p>
      <h3>Coaching advice</h3>
      <p>{debrief.coachingAdvice}</p>
    </section>
  );
}

function RosterSection({ detail }: { detail: MeetingDebriefDetail }) {
  return (
    <section aria-labelledby="debrief-roster">
      <h2 id="debrief-roster">Roster</h2>
      <p>
        {detail.linked
          ? `Calendar-linked: occurrence ${detail.occurrence?.occurrenceKey ?? "unknown"}`
          : "Not linked to Calendar"}
      </p>
      {detail.rosterStatus === "prefilled" ? (
        <p className="muted">Roster prefilled from the Calendar association.</p>
      ) : (
        <p className="status-badge status-attention" role="status">
          Roster confirmation required before review can complete.
        </p>
      )}
      {detail.roster.length === 0 ? (
        <p className="muted">No roster recorded.</p>
      ) : (
        <ul>
          {detail.roster.map((person) => (
            <li key={person.email}>
              {person.displayName ?? person.email} &lt;{person.email}&gt;
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function IdentitySection({ detail }: { detail: MeetingDebriefDetail }) {
  const identity = detail.identity;
  return (
    <section aria-labelledby="debrief-identity">
      <h2 id="debrief-identity">Identity (from the Transcript Catalog)</h2>
      <h3>Resolved</h3>
      {identity.resolved.length === 0 ? (
        <p className="muted">No resolved identities.</p>
      ) : (
        <ul>
          {identity.resolved.map((resolved) => (
            <li key={resolved.mentionId}>
              {resolved.surfaceText} —{" "}
              <Link to={`/people/${encodeURIComponent(resolved.profileId)}`}>
                confirmed Profile
              </Link>
            </li>
          ))}
        </ul>
      )}
      <h3>Unresolved</h3>
      {identity.unresolved.length === 0 ? (
        <p className="muted">Nothing unresolved.</p>
      ) : (
        <ul>
          {identity.unresolved.map((unresolved) => (
            <li key={unresolved.mentionId}>{unresolved.surfaceText} — awaiting review</li>
          ))}
        </ul>
      )}
      <h3>Organizations</h3>
      {identity.organizations.length === 0 ? (
        <p className="muted">No organizations mentioned.</p>
      ) : (
        <ul>
          {identity.organizations.map((organization) => (
            <li key={organization.mentionId}>{organization.surfaceText}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function MeetingDebriefDetailPage() {
  useTitle("Meeting Debrief detail");
  const { runId } = useParams<{ runId: string }>();
  const headingRef = usePageFocus<HTMLHeadingElement>();
  const [detail, setDetail] = useState<MeetingDebriefDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  const refresh = useCallback(async () => {
    if (!runId) return;
    setError(null);
    try {
      setDetail(await api.meetingDebriefDetail(runId));
      setNotFound(false);
    } catch (err) {
      if (/404|not found/i.test(errorMessage(err))) {
        setNotFound(true);
      } else {
        setError(errorMessage(err));
      }
    }
  }, [runId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="page">
      <p>
        <Link to="/meeting-debrief">← All Meeting Debriefs</Link>
      </p>
      <h1 ref={headingRef} tabIndex={-1}>
        {detail?.fileName ?? "Meeting Debrief"}
      </h1>
      {notFound && (
        <p className="banner-error" role="alert">
          Unknown Meeting Debrief.
        </p>
      )}
      {error && (
        <p className="banner-error" role="alert">
          {error}
        </p>
      )}
      {detail && (
        <>
          <p className="muted">
            Transcript {detail.transcriptId} · {detail.meetingDate ?? "no meeting date"} · Run{" "}
            {detail.status}
            {detail.reviewReadiness === "ready" ? " · ready for review" : ""}
          </p>
          <ExtractionSection detail={detail} />
          <RosterSection detail={detail} />
          <IdentitySection detail={detail} />
        </>
      )}
    </div>
  );
}
