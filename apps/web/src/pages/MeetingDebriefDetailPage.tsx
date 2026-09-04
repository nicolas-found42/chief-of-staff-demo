import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { MeetingDebriefDetail, MeetingDebriefField } from "@chief-of-staff-demo/shared";
import { MEETING_DEBRIEF_FIELDS } from "@chief-of-staff-demo/shared";
import { api, errorMessage } from "../client";
import { formatMeetingTime, statusLabel } from "../display";
import { meetingDebriefDetailName } from "../modules/meeting-debrief/naming";
import { usePageFocus } from "../usePageFocus";
import { useTitle } from "../useTitle";

const FIELD_LABELS: Record<(typeof MEETING_DEBRIEF_FIELDS)[number], string> = {
  summary: "Summary",
  decisions: "Decisions",
  actionItems: "Action items",
  openQuestions: "Open questions",
  effectivenessEvidence: "Effectiveness evidence",
  coachingAdvice: "Coaching advice",
};

const BLOCKER_LABELS: Record<string, string> = {
  "owner-identity-unconfirmed":
    "The workspace owner's Google identity is not confirmed in Settings.",
  "roster-unconfirmed": "The attendee roster is not confirmed yet.",
};

function blockerLabel(blocker: string): string {
  const known = BLOCKER_LABELS[blocker];
  if (known) return known;
  if (blocker.startsWith("attendee-unverified-email:")) {
    const email = blocker.slice("attendee-unverified-email:".length);
    return `${email} has no Person Profile with a verified (Calendar-anchored) email.`;
  }
  return blocker;
}

/** Where the owner goes to clear one blocker, when this page can settle it. */
function blockerTarget(blocker: string): string | null {
  if (blocker === "roster-unconfirmed") return "#debrief-roster";
  if (blocker === "owner-identity-unconfirmed") return "/settings";
  return null;
}

/**
 * What the Debrief extracted, and the two decisions the owner can take on an
 * action item. Done and Dismiss used to live in a second copy of this list
 * further down the page — the same items twice, one showing state and the
 * other offering the buttons — so a reader had to hold both in their head to
 * see where an item stood. One list carries both.
 */
function ExtractionSection({
  detail,
  act,
  actionable,
}: {
  detail: MeetingDebriefDetail;
  act: (run: () => Promise<unknown>) => void;
  actionable: boolean;
}) {
  const debrief = detail.extraction;
  if (!debrief) {
    return (
      <section aria-labelledby="debrief-extraction">
        <h2 id="debrief-extraction">Extraction</h2>
        <p className="muted">No extraction yet — the debrief is {statusLabel(detail.status)}.</p>
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
          {debrief.actionItems.map((item, index) => {
            const dismissed = detail.review?.droppedActionItems.includes(index) ?? false;
            const task = detail.review?.actionItemTasks.find((entry) => entry.index === index);
            const doneLocal = detail.review?.completedActionItems.includes(index) ?? false;
            return (
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
                {dismissed && <span className="status-badge status-attention"> Dismissed</span>}
                {!dismissed && task?.completed && (
                  <span className="status-badge status-ok"> Done in Google Tasks</span>
                )}
                {!dismissed && task && !task.completed && (
                  <span className="muted"> (Google Task open)</span>
                )}
                {!dismissed && !task && doneLocal && (
                  <span className="status-badge status-ok"> Done</span>
                )}
                {actionable && !doneLocal && !task?.completed && (
                  <>
                    {" "}
                    <button
                      type="button"
                      onClick={() =>
                        act(() => api.meetingDebriefDoneActionItem(detail.runId, index))
                      }
                    >
                      Done
                    </button>
                  </>
                )}
                {actionable && !dismissed && (
                  <>
                    {" "}
                    <button
                      type="button"
                      onClick={() =>
                        act(() => api.meetingDebriefDismissActionItem(detail.runId, index))
                      }
                    >
                      Dismiss
                    </button>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {actionable && debrief.actionItems.length > 0 && (
        <p className="muted">
          Done marks an item complete — its Google Task takes over once one exists. Dismiss removes
          it: a dismissed item never becomes a Google Task, even when the Debrief is published
          later. Marking one clears the other; regenerating action items clears both.
        </p>
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

/**
 * People and organizations the Catalog found in the transcript.
 *
 * Mentions are per-span: a name spoken three hundred times is three hundred
 * mentions of the same person. Listed one per span this section ran to tens of
 * thousands of rows and buried the Debrief above it, so it groups by name and
 * counts, and shows the most-mentioned first. The rest stay one disclosure
 * away rather than being dropped.
 */
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

const STATE_LABELS: Record<string, string> = {
  extracted: "Extracted",
  published: "Published — draft and Tasks written",
};

/**
 * One owner turn against a Debrief: run it, then re-read the detail. Held by
 * the page rather than by one section, because the action items above and the
 * roster and recipients below are all turns on the same Run.
 */
function useDebriefActions(onChanged: () => Promise<void> | void) {
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const act = useCallback(
    (run: () => Promise<unknown>) => {
      setBusy(true);
      setActionError(null);
      run()
        .then(() => onChanged())
        .catch((err: unknown) => setActionError(errorMessage(err)))
        .finally(() => setBusy(false));
    },
    [onChanged],
  );

  return { busy, actionError, setActionError, act };
}

type DebriefActions = ReturnType<typeof useDebriefActions>;

function ReviewSection({
  detail,
  actions,
}: {
  detail: MeetingDebriefDetail;
  actions: DebriefActions;
}) {
  const review = detail.review;
  const { busy, actionError, setActionError, act } = actions;
  const [rosterDraft, setRosterDraft] = useState("");
  const [recipientQuery, setRecipientQuery] = useState("");
  const [matches, setMatches] = useState<
    Array<{ id: string; fullName: string | null; primaryEmail: string | null }>
  >([]);

  const searchProfiles = useCallback(
    async (query: string) => {
      setActionError(null);
      try {
        setMatches(
          (await api.people(query)).map((profile) => ({
            id: profile.id,
            fullName: profile.fullName,
            primaryEmail: profile.primaryEmail,
          })),
        );
      } catch (err) {
        setActionError(errorMessage(err));
      }
    },
    [setActionError],
  );

  if (!review) return null;

  /* Everything stays editable until the outward writes go out. Publishing is
     what locks a Debrief — nothing else ever did, and waiting for review no
     longer does. */
  const actionable = review.state !== "published";
  /* The speakers the transcript recorded, in the roster field's own syntax and
     awaiting their emails. */
  const speakerDraft = detail.speakers.map((speaker) => `${speaker} <>`).join(", ");
  const entryDraft = rosterDraft
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => {
      const emailMatch = /<([^>]+)>|([^\s<]+@[^\s<]+\.[^\s<]+)/.exec(part);
      const email = emailMatch?.[1] ?? emailMatch?.[2] ?? "";
      const name = part
        .replace(/<[^>]*>/, "")
        .replace(/[^\s<]+@[^\s<]+\.[^\s<]+/, "")
        .trim();
      return email ? { email, displayName: name || null } : null;
    })
    .filter((entry): entry is { email: string; displayName: string | null } => entry !== null);

  return (
    <section aria-labelledby="debrief-review">
      <h2 id="debrief-review">Review</h2>
      <p
        className={`status-badge ${review.state === "published" ? "status-ok" : ""}`}
        role="status"
      >
        {STATE_LABELS[review.state] ?? review.state}
      </p>
      {review.duplicateWarning && (
        <p className="banner-error" role="alert">
          Duplicate output warning: this transcript already has a published Debrief (
          <Link
            to={`/meeting-debrief/${encodeURIComponent(review.duplicateWarning.approvedRunId)}`}
          >
            {review.duplicateWarning.approvedRunId}
          </Link>
          ). Redoing it may duplicate its Gmail draft and owner Tasks.
        </p>
      )}
      {actionError && (
        <p className="banner-error" role="alert">
          {actionError}
        </p>
      )}
      {busy && <p className="muted">Working…</p>}

      {actionable && (
        <>
          <h3>Regenerate a field</h3>
          <p className="muted">
            Regeneration re-extracts from the immutable transcript — the rejected value is never
            shown to the model again. Regenerating action items clears earlier done and dismiss
            decisions.
          </p>
          <ul>
            {(Object.keys(FIELD_LABELS) as MeetingDebriefField[]).map((field) => (
              <li key={field}>
                <button
                  type="button"
                  onClick={() => act(() => api.meetingDebriefRegenerate(detail.runId, field))}
                >
                  Regenerate {FIELD_LABELS[field]}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {/* Roster: one section, not two. The page used to state the roster here
          and again in a section of its own below, which disagreed with itself
          the moment either changed. */}
      <h3 id="debrief-roster">Roster confirmation</h3>
      <p className="muted">
        {detail.linked
          ? "Prefilled from the meeting's calendar attendees."
          : "No calendar event is linked to this transcript, so the attendees have to be named here."}
      </p>
      {review.roster.status === "confirmed" ? (
        <p className="status-badge status-ok" role="status">
          Roster confirmed
          {review.roster.confirmedAt ? ` ${formatMeetingTime(review.roster.confirmedAt)}` : ""}.
        </p>
      ) : (
        <p className="status-badge status-attention" role="status">
          Confirm the roster to publish the draft and Tasks.
        </p>
      )}
      {review.roster.entries.length === 0 ? (
        <p className="muted">No roster recorded.</p>
      ) : (
        <ul>
          {review.roster.entries.map((entry) => (
            <li key={entry.email}>
              {entry.displayName ?? entry.email} &lt;{entry.email}&gt;
              {entry.profileId ? (
                <>
                  {" "}
                  <Link to={`/people/${encodeURIComponent(entry.profileId)}`}>
                    (confirmed Profile)
                  </Link>
                </>
              ) : (
                <span className="muted"> (no Profile bound)</span>
              )}
            </li>
          ))}
        </ul>
      )}
      {actionable && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (entryDraft.length === 0) return;
            act(() => api.meetingDebriefConfirmRoster(detail.runId, entryDraft));
          }}
        >
          <label htmlFor="debrief-roster-input">
            Roster — one attendee per comma, as “Name &lt;email&gt;” or “email”
          </label>
          <input
            id="debrief-roster-input"
            value={rosterDraft}
            onChange={(event) => setRosterDraft(event.target.value)}
            placeholder="Alice <alice@example.com>, Bob <bob@example.com>"
          />
          <button type="submit" disabled={busy || entryDraft.length === 0}>
            Confirm roster
          </button>
          {/* The transcript already names who spoke. Retyping them was busywork
              the page could do itself; the emails still have to be supplied,
              because a spoken name is not a mailbox. */}
          {speakerDraft !== "" && rosterDraft === "" && (
            <p className="muted">
              Heard in the transcript:{" "}
              <button type="button" onClick={() => setRosterDraft(speakerDraft)}>
                Start from {detail.speakers.join(", ")}
              </button>
            </p>
          )}
        </form>
      )}

      <h3>Recipients</h3>
      <p className="muted">
        Every confirmed attendee other than the owner is a recipient automatically. Anyone else
        needs an explicit confirmed Person Profile with a verified email.
      </p>
      <ul>
        {review.automaticRecipients.map((recipient) => (
          <li key={recipient.profileId}>
            {recipient.email} — <span className="muted">automatic (confirmed attendee)</span>{" "}
            <Link to={`/people/${encodeURIComponent(recipient.profileId)}`}>(Profile)</Link>
          </li>
        ))}
        {review.additionalRecipients.map((recipient) => (
          <li key={recipient.profileId}>
            {recipient.email} —{" "}
            <span className="muted">added (confirmed Profile with verified email)</span>{" "}
            <Link to={`/people/${encodeURIComponent(recipient.profileId)}`}>(Profile)</Link>
            {actionable && (
              <>
                {" "}
                <button
                  type="button"
                  onClick={() =>
                    act(() => api.meetingDebriefRemoveRecipient(detail.runId, recipient.profileId))
                  }
                >
                  Remove
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
      {review.suggestedRecipients.length > 0 && (
        <p className="muted">
          Suggested from follow-up context:{" "}
          {review.suggestedRecipients
            .map(
              (suggestion) =>
                `${suggestion.name}${suggestion.email ? ` <${suggestion.email}>` : ""}`,
            )
            .join(", ")}
        </p>
      )}
      {actionable && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void searchProfiles(recipientQuery);
          }}
        >
          <label htmlFor="debrief-recipient-search">
            Search Person Profiles to add a recipient
          </label>
          <input
            id="debrief-recipient-search"
            value={recipientQuery}
            onChange={(event) => setRecipientQuery(event.target.value)}
          />
          <button type="submit">Search</button>
        </form>
      )}
      {matches.length > 0 && actionable && (
        <ul>
          {matches.map((profile) => (
            <li key={profile.id}>
              {profile.fullName ?? profile.id}{" "}
              {profile.primaryEmail && ` <${profile.primaryEmail}>`}{" "}
              <Link to={`/people/${encodeURIComponent(profile.id)}`}>(Profile)</Link>{" "}
              <button
                type="button"
                disabled={!profile.primaryEmail}
                onClick={() => {
                  if (profile.primaryEmail) {
                    act(() =>
                      api.meetingDebriefAddRecipient(detail.runId, {
                        profileId: profile.id,
                        email: profile.primaryEmail!,
                      }),
                    );
                  }
                }}
              >
                Add as recipient
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* The one gate left in the product. The Debrief itself is finished and
          readable above; this writes outward — a Gmail draft to the confirmed
          recipients, and Google Tasks for the owner's own actions. */}
      <h3>Publish outward</h3>
      <p className="muted">
        Publishing creates the Gmail draft and the Google Tasks. Nothing above waits on it — the
        Debrief is already complete.
      </p>
      {review.state === "published" ? (
        <p>
          Published{review.approvedAt ? ` ${formatMeetingTime(review.approvedAt)}` : ""}. The
          Debrief, roster, recipients, and decisions are locked so they stay aligned with what went
          out; redo starts a separate debrief.
        </p>
      ) : review.approvalBlockers.length > 0 ? (
        <div>
          <p className="muted" role="status">
            Publishing needs:
          </p>
          {/* Each blocker reaches whatever settles it. The list used to name
              the roster with the roster form a screen away and no way to it. */}
          <ul>
            {review.approvalBlockers.map((blocker) => {
              const target = blockerTarget(blocker);
              return (
                <li key={blocker}>
                  {target ? <a href={target}>{blockerLabel(blocker)}</a> : blockerLabel(blocker)}
                </li>
              );
            })}
          </ul>
        </div>
      ) : (
        <button
          type="button"
          disabled={busy}
          onClick={() => act(() => api.meetingDebriefApprove(detail.runId))}
        >
          Publish draft and Tasks
        </button>
      )}
      {review.state === "published" && (
        <button
          type="button"
          disabled={busy}
          onClick={() => act(() => api.meetingDebriefRedo(detail.runId))}
        >
          Redo (start a new debrief)
        </button>
      )}
    </section>
  );
}

/**
 * When the meeting was, and — only when there is something to say — what the
 * Debrief is still doing. A finished Debrief says nothing here: the engine's
 * own words for a Run ("Waiting", "Completed") described the Run, not the
 * retrospective, and "Waiting" contradicted the "Extracted" badge and the
 * page's own promise that nothing waits.
 */
function StatusLine({ detail }: { detail: MeetingDebriefDetail }) {
  const unfinished = detail.status !== "done";
  return (
    <p className="muted">
      {detail.meetingDate ?? "No meeting date"}
      {unfinished && ` · ${statusLabel(detail.status)}`}
      {detail.review?.state === "published" && (
        <>
          {" · "}
          <span className="status-badge status-ok" role="status">
            Published
          </span>
        </>
      )}
    </p>
  );
}

export function MeetingDebriefDetailPage() {
  const { runId } = useParams<{ runId: string }>();
  const headingRef = usePageFocus<HTMLHeadingElement>();
  const [detail, setDetail] = useState<MeetingDebriefDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [meetingTitles, setMeetingTitles] = useState<Map<string, string>>(new Map());

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

  const actions = useDebriefActions(refresh);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    let live = true;
    void api
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
  }, []);

  const name = detail ? meetingDebriefDetailName(detail, meetingTitles) : "Meeting Debrief";
  /* The tab carries the meeting, like every other Meeting Wizard page. A
     constant "Meeting Debrief detail" made two open debriefs indistinguishable
     in the browser's own list of them. */
  useTitle(name);

  return (
    <div className="page">
      <p>
        <Link to="/meeting-debrief">← All Meeting Debriefs</Link>
      </p>
      <h1 ref={headingRef} tabIndex={-1}>
        {name}
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
          <StatusLine detail={detail} />
          {/* The Meeting is where this retrospective belongs, and the Debrief
              already knows which one — the page just never said so. */}
          {detail.meetingId && (
            <p>
              <Link to={`/meetings/${encodeURIComponent(detail.meetingId)}`}>
                Open this meeting
              </Link>
            </p>
          )}
          <ExtractionSection
            detail={detail}
            act={actions.act}
            actionable={detail.review !== null && detail.review.state !== "published"}
          />
          <ReviewSection detail={detail} actions={actions} />
          <IdentitySection detail={detail} />
        </>
      )}
    </div>
  );
}
