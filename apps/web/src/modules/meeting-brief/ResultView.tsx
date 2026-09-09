import { MeetingBriefContent } from "../../components/MeetingBriefContent";
import { ReadingDisclosure } from "../../components/ReadingDisclosure";
import "../../pages/meetingWizard.css";
import { useEffect, useState } from "react";
import type { MeetingBriefRunResult, RunDetail } from "@chief-of-staff-demo/shared";
import { Link, useNavigate } from "react-router-dom";
import { BriefProfileRefresh } from "./BriefProfileRefresh";
import { meetingsApi, type MeetingsClient } from "../../clients/meetings";
import { deliveryPresentation } from "./deliveryStatus";

export function MeetingBriefResultView({
  detail,
  client = meetingsApi,
}: {
  detail: RunDetail;
  client?: MeetingsClient;
}) {
  const navigate = useNavigate();
  const [earlier, setEarlier] = useState(false);
  const result = detail.result as MeetingBriefRunResult | null;
  useEffect(() => {
    if (!result?.occurrenceKey) return;
    let live = true;
    void client
      .meetings()
      .then(async ({ meetings }) => {
        const owning = meetings.find((meeting) => meeting.occurrenceKey === result.occurrenceKey);
        if (!owning) return;
        const view = await client.meetingRead(owning.id);
        if (!live) return;
        if (view.meeting.brief.runId === detail.id)
          void navigate(`/meetings/${owning.id}?tab=brief`, { replace: true });
        else setEarlier(true);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [client, detail.id, result?.occurrenceKey, navigate]);
  if (!result) {
    if (detail.status === "skipped") {
      return (
        <section className="meeting-reading" aria-labelledby="meeting-brief-result">
          <h2 id="meeting-brief-result">Meeting Brief</h2>
          <p className="muted">
            This meeting was not eligible at preparation time — no brief was produced.
          </p>
          {detail.skipReason ? <p role="status">{detail.skipReason}</p> : null}
        </section>
      );
    }
    return null;
  }
  const brief = result.meetingBrief;
  const delivery = result.delivery;
  const deliveryStatus = deliveryPresentation(delivery.status);
  const logistics = brief.logistics;

  return (
    <section className="meeting-reading" aria-labelledby="meeting-brief-result">
      <h2 id="meeting-brief-result">Meeting Brief</h2>

      {result.supersedes ? (
        <p className="muted" role="status">
          Revision of <Link to={`/runs/${result.supersedes}`}>previous brief</Link> (supersedes{" "}
          {result.supersedes})
        </p>
      ) : null}

      {earlier && <p role="status">Earlier version · this link retains the original Brief.</p>}
      <BriefProfileRefresh runId={detail.id} client={client} />
      <MeetingBriefContent brief={brief} versionId={detail.id} />
      <ReadingDisclosure id={`${detail.id}-metadata`} label="Brief technical metadata">
        <div className="card">
          <h3>Logistics</h3>
          <dl className="receipt-grid">
            <div className="receipt-row">
              <dt>Title</dt>
              <dd>{logistics.title}</dd>
            </div>
            <div className="receipt-row">
              <dt>Start</dt>
              <dd>
                <time dateTime={logistics.startAt}>
                  {new Date(logistics.startAt).toLocaleString()}
                </time>
              </dd>
            </div>
            <div className="receipt-row">
              <dt>End</dt>
              <dd>
                <time dateTime={logistics.endAt}>{new Date(logistics.endAt).toLocaleString()}</time>
              </dd>
            </div>
            <div className="receipt-row">
              <dt>Location</dt>
              <dd>{logistics.location ?? "—"}</dd>
            </div>
            <div className="receipt-row">
              <dt>Conference link</dt>
              <dd>
                {logistics.conferenceLink ? (
                  <a href={logistics.conferenceLink} target="_blank" rel="noreferrer">
                    {logistics.conferenceLink}{" "}
                    <span className="visually-hidden">(opens in a new tab)</span>
                  </a>
                ) : (
                  "—"
                )}
              </dd>
            </div>
            <div className="receipt-row">
              <dt>Event version</dt>
              <dd>{result.eventVersion}</dd>
            </div>
            <div className="receipt-row">
              <dt>Occurrence</dt>
              <dd>{result.occurrenceKey}</dd>
            </div>
          </dl>
        </div>
      </ReadingDisclosure>

      <div className="card">
        <h3>Delivery</h3>
        <p role="status">
          <span className={`status-badge ${deliveryStatus.className}`}>{deliveryStatus.label}</span>{" "}
          {delivery.attempts > 0 ? `· attempts: ${delivery.attempts}` : ""}
        </p>
        {delivery.recipient ? <p>Recipient: {delivery.recipient}</p> : null}
        {delivery.messageId ? <p>Message ID: {delivery.messageId}</p> : null}
        {delivery.deliveryId ? <p>Delivery ID: {delivery.deliveryId}</p> : null}
        {delivery.sentAt ? (
          <p>
            Sent at:{" "}
            <time dateTime={delivery.sentAt}>{new Date(delivery.sentAt).toLocaleString()}</time>
          </p>
        ) : null}
        {deliveryStatus.explanation ? (
          <p
            className={deliveryStatus.isError ? "field-error" : "muted"}
            role={deliveryStatus.isError ? "alert" : undefined}
          >
            {deliveryStatus.explanation}
          </p>
        ) : null}
        <p className="muted">
          Delivery is fixed to the workspace owner&apos;s connected Google identity; External Guests
          are never emailed.
        </p>
      </div>
      <details className="disclosure">
        <summary>Source JSON</summary>
        <pre>{JSON.stringify(brief, null, 2)}</pre>
      </details>
    </section>
  );
}
