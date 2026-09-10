import { useCallback, useEffect, useState } from "react";
import { Link, useParams, useNavigate } from "react-router-dom";
import type { MeetingDebriefDetail } from "@chief-of-staff-demo/shared";
import { errorMessage } from "../client";
import { meetingsApi, type MeetingsClient } from "../clients/meetings";
import { statusLabel } from "../display";
import { meetingDebriefDetailName } from "../modules/meeting-debrief/naming";
import { usePageFocus } from "../usePageFocus";
import { useTitle } from "../useTitle";
import { MeetingDebriefContent } from "../components/MeetingDebriefContent";
import { ReadingDisclosure } from "../components/ReadingDisclosure";
import "./meetingWizard.css";

const IDENTITY_ROWS_SHOWN = 12;

interface NamedMention {
  mentionId: string;
  surfaceText: string;
}

/** One row per distinct name, most mentioned first, ties broken alphabetically. */
function groupMentions(mentions: NamedMention[]): { name: string; count: number; key: string }[] {
  const byName = new Map<string, { name: string; count: number; key: string }>();
  for (const mention of mentions) {
    const name = mention.surfaceText.trim();
    if (name === "") continue;
    const key = name.toLocaleLowerCase();
    const found = byName.get(key);
    if (found) found.count += 1;
    else byName.set(key, { name, count: 1, key });
  }
  return [...byName.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function MentionList({ mentions, empty }: { mentions: NamedMention[]; empty: string }) {
  const [expanded, setExpanded] = useState(false);
  const groups = groupMentions(mentions);
  if (groups.length === 0) return <p className="muted">{empty}</p>;
  const shown = expanded ? groups : groups.slice(0, IDENTITY_ROWS_SHOWN);
  const hidden = groups.length - shown.length;
  return (
    <>
      <p className="muted">
        {groups.length} name{groups.length === 1 ? "" : "s"} across {mentions.length} mention
        {mentions.length === 1 ? "" : "s"}.
      </p>
      <ul className="mention-list">
        {shown.map((group) => (
          <li key={group.key}>
            {group.name}
            {group.count > 1 ? <span className="muted"> ×{group.count}</span> : null}
          </li>
        ))}
      </ul>
      {hidden > 0 && (
        <button type="button" className="action-button" onClick={() => setExpanded(true)}>
          Show {hidden} more
        </button>
      )}
    </>
  );
}

function IdentitySection({ detail }: { detail: MeetingDebriefDetail }) {
  const identity = detail.identity;
  return (
    <section aria-labelledby="debrief-identity">
      <h2 id="debrief-identity">Who and what was mentioned</h2>
      <h3>Matched to a Person Profile</h3>
      {identity.resolved.length === 0 ? (
        <p className="muted">No mention matched a Person Profile.</p>
      ) : (
        <ul className="mention-list">
          {identity.resolved.map((resolved) => (
            <li key={resolved.mentionId}>
              {resolved.surfaceText} —{" "}
              <Link to={`/people/${encodeURIComponent(resolved.profileId)}`}>Profile</Link>
            </li>
          ))}
        </ul>
      )}
      <h3>Other names heard</h3>
      <MentionList mentions={identity.unresolved} empty="No other names were picked up." />
      <h3>Organizations</h3>
      <MentionList mentions={identity.organizations} empty="No organizations mentioned." />
    </section>
  );
}

export function MeetingDebriefDetailPage({ client = meetingsApi }: { client?: MeetingsClient }) {
  const { runId } = useParams<{ runId: string }>();
  const navigate = useNavigate();
  const [earlier, setEarlier] = useState(false);
  const headingRef = usePageFocus<HTMLHeadingElement>();
  const [detail, setDetail] = useState<MeetingDebriefDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [meetingTitles, setMeetingTitles] = useState<Map<string, string>>(new Map());

  const refresh = useCallback(async () => {
    if (!runId) return;
    setError(null);
    try {
      setDetail(await client.meetingDebriefDetail(runId));
      setNotFound(false);
    } catch (err) {
      if (/404|not found/i.test(errorMessage(err))) {
        setNotFound(true);
      } else {
        setError(errorMessage(err));
      }
    }
  }, [client, runId]);

  useEffect(() => {
    if (!detail?.meetingId) return;
    let live = true;
    void client
      .meetingRead(detail.meetingId)
      .then((view) => {
        if (!live) return;
        if (view.meeting.debrief.runId === detail.runId)
          void navigate(`/meetings/${encodeURIComponent(detail.meetingId!)}?tab=debrief`, {
            replace: true,
          });
        else setEarlier(true);
      })
      .catch(() => {
        /* Keep the exact standalone artifact readable. */
      });
    return () => {
      live = false;
    };
  }, [client, detail?.meetingId, detail?.runId, navigate]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    let live = true;
    void client
      .meetings()
      .then((meetings) => {
        if (!live) return;
        setMeetingTitles(new Map(meetings.meetings.map((meeting) => [meeting.id, meeting.title])));
      })
      .catch(() => {
        // A missing title only costs the file-name fallback, never the page.
      });
    return () => {
      live = false;
    };
  }, [client]);

  const name = detail ? meetingDebriefDetailName(detail, meetingTitles) : "Meeting Debrief";
  /* The tab carries the meeting, like every other Meeting Wizard page. A
     constant "Meeting Debrief detail" made two open debriefs indistinguishable
     in the browser's own list of them. */
  useTitle(name);

  return (
    <div className="page meeting-reading">
      <p>
        <Link to="/meeting-debrief">← All Meeting Debriefs</Link>
      </p>
      <h1 ref={headingRef} tabIndex={-1}>
        {name}
      </h1>
      {notFound && runId && (
        <p>
          <Link to={`/meetings/recovery/${encodeURIComponent(runId)}`}>
            Recover retained proposals
          </Link>
        </p>
      )}
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
          {earlier && (
            <p role="status">Earlier version · this link retains the original Debrief.</p>
          )}
          <p className="muted">
            {detail.meetingDate ?? "Meeting date unavailable"} ·{" "}
            {detail.extraction ? "Debrief ready" : statusLabel(detail.status)}
          </p>
          {/* The Meeting is where this retrospective belongs, and the Debrief
              already knows which one — the page just never said so. */}
          {detail.meetingId && (
            <p>
              <Link to={`/meetings/${encodeURIComponent(detail.meetingId)}`}>
                Open this meeting
              </Link>
            </p>
          )}
          {detail.extraction ? (
            <MeetingDebriefContent
              key={detail.runId}
              earlierVersion={earlier}
              reviewOnMeeting
              detail={detail}
              refresh={refresh}
              client={client}
            />
          ) : (
            <p role="status">
              {detail.status === "running" || detail.status === "pending"
                ? "Preparing the Debrief. This page updates automatically."
                : "No readable Debrief yet. Check the workflow settings and retry the supported preparation action."}
            </p>
          )}
          <ReadingDisclosure
            id={`${detail.runId}-identity`}
            label="Transcript and identity details"
          >
            {detail.sourceUrl && (
              <p>
                <a href={detail.sourceUrl} target="_blank" rel="noreferrer">
                  Open source transcript
                </a>
              </p>
            )}
            <IdentitySection detail={detail} />
          </ReadingDisclosure>
        </>
      )}
    </div>
  );
}
