import { proposedDue } from "../meetingDisplay";
import { Link } from "react-router-dom";
import { useEffect, useRef, useState } from "react";
import {
  debriefSectionResolved,
  type DebriefSectionAvailability,
  type DebriefSectionName,
  type MeetingDebriefDetail,
  type MeetingDebriefField,
} from "@chief-of-staff-demo/shared";
import { meetingsApi, type MeetingsClient } from "../clients/meetings";
import { errorMessage } from "../client";
import { MeetingActionItems } from "./MeetingActionItems";
import { DebriefEmailPanel } from "./DebriefEmailPanel";
import { HandoffDetail } from "./HandoffDetail";
import { ReadingDisclosure } from "./ReadingDisclosure";

const labels: Record<DebriefSectionName, string> = {
  summary: "Summary",
  decisions: "Decisions",
  actionItems: "Action Items",
  openQuestions: "Open questions",
  effectivenessEvidence: "Effectiveness evidence",
  coachingAdvice: "Coaching advice",
  suggestedRecipients: "Suggested recipients",
};

/** A section that is not available: never rendered as an empty result (#345). */
function SectionUnavailable({ section }: { section: DebriefSectionAvailability | null }) {
  return (
    <p className="muted" role="status">
      {section?.reason ?? "This section could not be produced."} Retry it to try again.
    </p>
  );
}

/** Complete reading content. Every mutation stays with its existing owner. */
export function MeetingDebriefContent({
  detail,
  earlierVersion = false,
  reviewOnMeeting = false,
  refresh,
  client = meetingsApi,
}: {
  detail: MeetingDebriefDetail;
  earlierVersion?: boolean;
  reviewOnMeeting?: boolean;
  refresh: () => Promise<void>;
  client?: MeetingsClient;
}) {
  const [confirm, setConfirm] = useState<MeetingDebriefField | null>(null);
  const [working, setWorking] = useState<MeetingDebriefField | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);
  const [allDecisions, setAllDecisions] = useState(
    () => sessionStorage.getItem(`decisions:${detail.runId}`) === "all",
  );
  const [allSummary, setAllSummary] = useState(
    () => sessionStorage.getItem(`summary:${detail.runId}`) === "all",
  );
  const [actionJump, setActionJump] = useState(0);
  const [actionCount, setActionCount] = useState<number | null>(null);
  const [retrying, setRetrying] = useState(false);
  const extraction = detail.extraction;
  /* Section availability is what tells a missing section from an empty one
     (#345): an unavailable section is never rendered as "none recorded". */
  const revision = detail.revision ?? null;
  const sectionOf = (name: DebriefSectionName): DebriefSectionAvailability | null =>
    revision?.sections.find((section) => section.name === name) ?? null;
  const available = (name: DebriefSectionName) => {
    const section = sectionOf(name);
    return section === null || debriefSectionResolved(section.state);
  };
  const unavailable = (revision?.sections ?? []).filter(
    (section) => !debriefSectionResolved(section.state),
  );
  const incomplete = revision?.completeness === "incomplete";
  const sectionName = (name: DebriefSectionName) => labels[name];
  const retrySections = async () => {
    setRetrying(true);
    setError(null);
    try {
      await client.meetingDebriefEarlyReview(detail.runId);
      await refresh();
    } catch (cause: unknown) {
      setError(errorMessage(cause));
    } finally {
      setRetrying(false);
    }
  };
  useEffect(() => {
    if (!working || detail.status === "running" || detail.status === "pending") return;
    if (started.current) return;
    setNotice(
      detail.status === "failed"
        ? `${labels[working]} could not be updated. The previous result is still available.`
        : `${labels[working]} updated.`,
    );
    setWorking(null);
  }, [detail, working]);
  const regenerate = (field: MeetingDebriefField) =>
    detail.review?.approvedAt || (!incomplete && detail.status !== "done") ? null : (
      <button type="button" disabled={working !== null} onClick={() => setConfirm(field)}>
        Regenerate {labels[field]}
      </button>
    );
  if (!extraction) return <p>No Debrief content is available yet.</p>;
  return (
    <div className="meeting-debrief-content">
      {incomplete && (
        <div className="card" role="status" aria-label="Incomplete Debrief">
          <p>
            This Debrief is incomplete and review-only. Unavailable:{" "}
            {unavailable.map((section) => sectionName(section.name)).join(", ")}. Nothing missing is
            shown as an empty result.
          </p>
          <button type="button" disabled={retrying} onClick={() => void retrySections()}>
            Retry unavailable sections
          </button>
        </div>
      )}
      <DebriefEmailPanel detail={detail} client={client} refresh={refresh} />
      <nav aria-label="Debrief sections" className="toolbar">
        <a href="#debrief-summary">Summary</a>
        <a
          href="#debrief-decisions"
          onClick={() => {
            setAllDecisions(true);
            sessionStorage.setItem(`decisions:${detail.runId}`, "all");
          }}
        >
          Decisions ({available("decisions") ? extraction.decisions.length : "unavailable"})
        </a>
        <a href="#action-items" onClick={() => setActionJump((value) => value + 1)}>
          Action Items{actionCount === null ? "" : ` (${actionCount})`}
        </a>
        <a href="#debrief-questions">
          Open questions (
          {available("openQuestions") ? extraction.openQuestions.length : "unavailable"})
        </a>
      </nav>
      <p role="status">{notice}</p>
      {error && <p role="alert">{error}</p>}
      {confirm && (
        <div className="card" role="region" aria-label="Confirm regeneration">
          <p>Regenerate {labels[confirm]} from the retained transcript?</p>
          {confirm === "actionItems" && (
            <p>
              New proposals may be added. Existing Tasks and canonical review decisions survive.
            </p>
          )}
          <button
            type="button"
            disabled={working !== null}
            onClick={() => {
              if (started.current) return;
              const field = confirm;
              started.current = true;
              setWorking(field);
              setError(null);
              setNotice(`Updating ${labels[field]}…`);
              setConfirm(null);
              void client
                .meetingDebriefRegenerate(detail.runId, field)
                .then(async () => {
                  started.current = false;
                  await refresh();
                })
                .catch((cause: unknown) => {
                  started.current = false;
                  setWorking(null);
                  setError(errorMessage(cause));
                });
            }}
          >
            Confirm regeneration
          </button>{" "}
          <button type="button" onClick={() => setConfirm(null)}>
            Cancel regeneration
          </button>
        </div>
      )}
      <section tabIndex={-1} id="debrief-summary" aria-labelledby="debrief-summary-heading">
        <h3 id="debrief-summary-heading">Summary</h3>
        {!available("summary") && <SectionUnavailable section={sectionOf("summary")} />}
        {available("summary") && (
          <>
            <p
              className={
                allSummary || extraction.summary.length <= 200 ? undefined : "bounded-summary"
              }
            >
              {extraction.summary}
            </p>
            {extraction.summary.length > 200 && (
              <button
                type="button"
                aria-expanded={allSummary}
                onClick={() => {
                  sessionStorage.setItem(`summary:${detail.runId}`, allSummary ? "bounded" : "all");
                  setAllSummary(!allSummary);
                }}
              >
                {allSummary ? "Read less" : "Read more"}
              </button>
            )}
          </>
        )}{" "}
        {regenerate("summary")}
      </section>
      <section tabIndex={-1} id="debrief-decisions" aria-labelledby="debrief-decisions-heading">
        <h3 id="debrief-decisions-heading">Decisions</h3>
        {!available("decisions") && <SectionUnavailable section={sectionOf("decisions")} />}
        {available("decisions") && extraction.decisions.length === 0 ? (
          <p className="muted">No decisions recorded.</p>
        ) : (
          <ul>
            {(allDecisions ? extraction.decisions : extraction.decisions.slice(0, 5)).map(
              (decision, index) => (
                <li key={index}>
                  {decision.statement}
                  <ReadingDisclosure
                    id={`${detail.runId}-decision-${index}`}
                    label="Decision evidence"
                  >
                    <p>{decision.evidence ?? "Stored evidence unavailable."}</p>
                  </ReadingDisclosure>
                </li>
              ),
            )}
          </ul>
        )}
        {available("decisions") && extraction.decisions.length > 5 && (
          <button
            type="button"
            aria-expanded={allDecisions}
            onClick={() => {
              sessionStorage.setItem(`decisions:${detail.runId}`, allDecisions ? "bounded" : "all");
              setAllDecisions(!allDecisions);
            }}
          >
            {allDecisions
              ? "Show fewer decisions"
              : `Show all ${extraction.decisions.length} decisions`}
          </button>
        )}{" "}
        {regenerate("decisions")}
      </section>
      {reviewOnMeeting ? (
        <section id="action-items" aria-labelledby="historical-actions-heading">
          <h3 id="historical-actions-heading">Action Items</h3>
          <p>Original extracted proposals · current review state is on the source Meeting.</p>
          <ul>
            {extraction.actionItems.map((item, index) => (
              <li key={index}>
                <p>
                  {item.title} · {item.owner ?? "Unassigned"}
                </p>
                <p>{proposedDue(item.dueDate, new Date().toISOString().slice(0, 10))}</p>
                {item.handoff && (
                  <ReadingDisclosure
                    id={`${detail.runId}-${index}-handoff`}
                    label="Execution details"
                  >
                    <HandoffDetail handoff={item.handoff} />
                  </ReadingDisclosure>
                )}
              </li>
            ))}
          </ul>
          <p>
            Review proposals with their source Meeting. Existing decisions and Tasks are retained.
          </p>
          <Link to={`/meetings/recovery/${encodeURIComponent(detail.runId)}`}>
            Review on source Meeting
          </Link>
        </section>
      ) : (
        <MeetingActionItems
          revealRequest={actionJump}
          onCount={setActionCount}
          meetingId={earlierVersion ? null : detail.meetingId}
          runId={detail.runId}
          regeneration={regenerate("actionItems")}
        />
      )}
      <section tabIndex={-1} id="debrief-questions" aria-labelledby="debrief-questions-heading">
        <h3 id="debrief-questions-heading">Open questions</h3>
        {!available("openQuestions") && <SectionUnavailable section={sectionOf("openQuestions")} />}
        {available("openQuestions") && extraction.openQuestions.length === 0 ? (
          <p className="muted">No open questions recorded.</p>
        ) : (
          <ul>
            {extraction.openQuestions.map((question, index) => (
              <li key={index}>
                {question.question}
                {question.raisedBy ? ` — ${question.raisedBy}` : ""}
              </li>
            ))}
          </ul>
        )}
        {regenerate("openQuestions")}
      </section>
      <ReadingDisclosure id={`${detail.runId}-coaching`} label="Meeting effectiveness and coaching">
        <h3>Effectiveness evidence</h3>
        {available("effectivenessEvidence") ? (
          <p>{extraction.effectivenessEvidence}</p>
        ) : (
          <SectionUnavailable section={sectionOf("effectivenessEvidence")} />
        )}
        {regenerate("effectivenessEvidence")}
        <h3>Coaching advice</h3>
        {available("coachingAdvice") ? (
          <p>{extraction.coachingAdvice}</p>
        ) : (
          <SectionUnavailable section={sectionOf("coachingAdvice")} />
        )}
        {regenerate("coachingAdvice")}
      </ReadingDisclosure>
    </div>
  );
}
