import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { MeetingDebriefDetail, MeetingDebriefField } from "@chief-of-staff-demo/shared";
import { MEETING_DEBRIEF_FIELDS } from "@chief-of-staff-demo/shared";
import { api, errorMessage } from "../client";
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
          {debrief.actionItems.map((item, index) => {
            const dropped = detail.review?.droppedActionItems.includes(index) ?? false;
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
                {dropped && <span className="status-badge status-attention"> Dropped</span>}
              </li>
            );
          })}
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
  const review = detail.review;
  return (
    <section aria-labelledby="debrief-roster">
      <h2 id="debrief-roster">Roster</h2>
      <p>
        {detail.linked
          ? `Calendar-linked: occurrence ${detail.occurrence?.occurrenceKey ?? "unknown"}`
          : "Not linked to Calendar"}
      </p>
      {review === null ? (
        detail.rosterStatus === "prefilled" ? (
          <p className="muted">Roster prefilled from the Calendar association.</p>
        ) : (
          <p className="status-badge status-attention" role="status">
            Roster confirmation required before review can complete.
          </p>
        )
      ) : review.roster.status === "confirmed" ? (
        <p className="status-badge status-ok" role="status">
          Roster confirmed{review.roster.confirmedAt ? ` at ${review.roster.confirmedAt}` : ""}.
        </p>
      ) : (
        <p className="status-badge status-attention" role="status">
          Roster confirmation required before review can complete.
        </p>
      )}
      {review === null ? (
        detail.roster.length === 0 ? (
          <p className="muted">No roster recorded.</p>
        ) : (
          <ul>
            {detail.roster.map((person) => (
              <li key={person.email}>
                {person.displayName ?? person.email} &lt;{person.email}&gt;
              </li>
            ))}
          </ul>
        )
      ) : review.roster.entries.length === 0 ? (
        <p className="muted">No roster recorded.</p>
      ) : (
        <ul>
          {review.roster.entries.map((entry) => (
            <li key={entry.email}>
              {entry.displayName ?? entry.email} &lt;{entry.email}&gt;
              {entry.profileId && (
                <>
                  {" "}
                  <Link to={`/people/${encodeURIComponent(entry.profileId)}`}>
                    (confirmed Profile)
                  </Link>
                </>
              )}
              {!entry.profileId && <span className="muted"> (no Profile bound yet)</span>}
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

const STATE_LABELS: Record<string, string> = {
  awaiting_review: "Awaiting your review",
  approved: "Approved — locked",
  expired: "Expired — skipped after 30 days unreviewed",
};

function ReviewSection({
  detail,
  onChanged,
}: {
  detail: MeetingDebriefDetail;
  onChanged: () => void;
}) {
  const review = detail.review;
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [rosterDraft, setRosterDraft] = useState("");
  const [recipientQuery, setRecipientQuery] = useState("");
  const [matches, setMatches] = useState<
    Array<{ id: string; fullName: string | null; primaryEmail: string | null }>
  >([]);

  const act = useCallback(
    async (run: () => Promise<unknown>) => {
      setBusy(true);
      setActionError(null);
      try {
        await run();
        onChanged();
      } catch (err) {
        setActionError(errorMessage(err));
      } finally {
        setBusy(false);
      }
    },
    [onChanged],
  );

  const searchProfiles = useCallback(async (query: string) => {
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
  }, []);

  if (!review) return null;

  const actionable = review.state === "awaiting_review";
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
        className={`status-badge ${review.state === "approved" ? "status-ok" : review.state === "expired" ? "status-attention" : ""}`}
        role="status"
      >
        {STATE_LABELS[review.state] ?? review.state}
      </p>
      {review.duplicateWarning && (
        <p className="banner-error" role="alert">
          Duplicate output warning: this transcript already has an approved Debrief (
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
      {review.state === "expired" && (
        <p className="muted">The Debrief expired unreviewed; no draft or Task was written.</p>
      )}
      {busy && <p className="muted">Working…</p>}

      {actionable && (
        <>
          <h3>Regenerate a field</h3>
          <p className="muted">
            Regeneration re-extracts from the immutable transcript — the rejected value is never
            shown to the model again. Regenerating action items clears earlier drop decisions.
          </p>
          <ul>
            {(Object.keys(FIELD_LABELS) as MeetingDebriefField[]).map((field) => (
              <li key={field}>
                <button
                  type="button"
                  onClick={() => void act(() => api.meetingDebriefRegenerate(detail.runId, field))}
                >
                  Regenerate {FIELD_LABELS[field]}
                </button>
              </li>
            ))}
          </ul>

          <h3>Drop action items</h3>
          <p className="muted">
            Dropping removes one action item from the Debrief. It cannot be undone except by
            regenerating action items.
          </p>
          <ul>
            {detail.extraction?.actionItems.map((item, index) =>
              review.droppedActionItems.includes(index) ? null : (
                <li key={index}>
                  <button
                    type="button"
                    onClick={() =>
                      void act(() => api.meetingDebriefDropActionItem(detail.runId, index))
                    }
                  >
                    Drop “{item.title}”
                  </button>
                </li>
              ),
            )}
          </ul>
        </>
      )}

      <h3>Roster confirmation</h3>
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
      {actionable && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (entryDraft.length === 0) return;
            void act(() => api.meetingDebriefConfirmRoster(detail.runId, entryDraft));
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
                    void act(() =>
                      api.meetingDebriefRemoveRecipient(detail.runId, recipient.profileId),
                    )
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
                    void act(() =>
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

      <h3>Approval</h3>
      {review.state === "approved" ? (
        <p>
          Approved and locked{review.approvedAt ? ` at ${review.approvedAt}` : ""}. The Debrief,
          roster, recipients, and review decisions cannot change; redo starts a separate Run.
        </p>
      ) : review.state === "expired" ? null : review.approvalBlockers.length > 0 ? (
        <div>
          <p className="muted" role="status">
            Approval is blocked until:
          </p>
          <ul>
            {review.approvalBlockers.map((blocker) => (
              <li key={blocker}>{blockerLabel(blocker)}</li>
            ))}
          </ul>
        </div>
      ) : (
        <button
          type="button"
          disabled={busy}
          onClick={() => void act(() => api.meetingDebriefApprove(detail.runId))}
        >
          Approve Debrief
        </button>
      )}
      {review.state === "approved" && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void act(() => api.meetingDebriefRedo(detail.runId))}
        >
          Redo (start a new Debrief Run)
        </button>
      )}
    </section>
  );
}

function StatusLine({ detail }: { detail: MeetingDebriefDetail }) {
  const state = detail.review?.state;
  const badge = state === "approved" ? "status-ok" : state === "expired" ? "status-attention" : "";
  return (
    <p className="muted">
      Transcript {detail.transcriptId} · {detail.meetingDate ?? "no meeting date"} · Run{" "}
      {detail.status}
      {state && (
        <>
          {" · "}
          <span className={`status-badge ${badge}`} role="status">
            {STATE_LABELS[state] ?? state}
          </span>
        </>
      )}
      {detail.reviewReadiness === "ready" && !state ? " · ready for review" : ""}
    </p>
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
          <StatusLine detail={detail} />
          <ExtractionSection detail={detail} />
          <ReviewSection detail={detail} onChanged={() => void refresh()} />
          <RosterSection detail={detail} />
          <IdentitySection detail={detail} />
        </>
      )}
    </div>
  );
}
