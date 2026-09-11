import type { MeetingBrief } from "@chief-of-staff-demo/shared";
import { ReadingDisclosure } from "./ReadingDisclosure";

/** A hostname is an honest fallback when stored evidence has no document title. */
function Source({ value, index }: { value: string; index: number }) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return <span>{value}</span>;
    return (
      <a href={url.href} target="_blank" rel="noreferrer">
        Source {index + 1} · {url.hostname}
      </a>
    );
  } catch {
    return <span>{value}</span>;
  }
}

export function MeetingBriefContent({
  brief,
  versionId,
}: {
  brief: MeetingBrief;
  versionId: string;
}) {
  return (
    <div>
      <h3>Meeting context</h3>
      <p>{brief.summary}</p>
      {brief.logistics.location && <p>Location: {brief.logistics.location}</p>}
      {brief.logistics.conferenceLink && (
        <p>
          <a href={brief.logistics.conferenceLink} target="_blank" rel="noreferrer">
            Join meeting
          </a>
        </p>
      )}
      <h3>Conversation starters</h3>
      {brief.conversationStarters.length ? (
        <ol>
          {brief.conversationStarters.map((starter, index) => (
            <li key={index}>{starter}</li>
          ))}
        </ol>
      ) : (
        <p className="muted">No conversation starters recorded.</p>
      )}
      {(brief.uncertainty.length > 0 || brief.missingEvidence.length > 0) && (
        <div>
          <p className="muted">Some context is uncertain or missing supporting evidence.</p>
          <ReadingDisclosure
            id={`${versionId}-uncertainty`}
            label="Uncertainty and missing evidence"
          >
            <ul>
              {[...brief.uncertainty, ...brief.missingEvidence].map((item, index) => (
                <li key={index}>{item}</li>
              ))}
            </ul>
          </ReadingDisclosure>
        </div>
      )}
      <h3>Context freshness</h3>
      {!brief.contextFreshness || brief.contextFreshness.items.length === 0 ? (
        <p className="muted">No dated provenance recorded for this brief; freshness is unknown.</p>
      ) : (
        <div>
          <p className="muted">
            Windows: current role and company evidence{" "}
            {brief.contextFreshness.windows.currentRoleCompanyHours}h, news and conversation hooks{" "}
            {brief.contextFreshness.windows.newsConversationHookHours}h.
          </p>
          {brief.contextFreshness.items.some((item) => item.qualification !== null) ? (
            <ul>
              {brief.contextFreshness.items
                .filter((item) => item.qualification !== null)
                .map((item) => (
                  <li key={`${item.claimId}-${item.source}`}>{item.qualification}</li>
                ))}
            </ul>
          ) : (
            <p className="muted">Every researched item is dated within its freshness window.</p>
          )}
        </div>
      )}
      <h3>Guests</h3>
      {brief.guests.length === 0 ? (
        <p className="muted">No guest context recorded.</p>
      ) : (
        <ul>
          {brief.guests.map((guest) => (
            <li key={guest.email}>
              <h4>{guest.name ?? guest.email}</h4>
              <p className="muted">
                {guest.role}
                {guest.role ? " · " : ""}
                {guest.email}
              </p>
              {guest.background && <p>{guest.background}</p>}
              {guest.relationshipHistory.length > 0 && (
                <p>Relationship history: {guest.relationshipHistory.join(" · ")}</p>
              )}
              {guest.crmContext && <p>{guest.crmContext}</p>}
              {guest.talkingPoints.length > 0 && (
                <ul>
                  {guest.talkingPoints.map((point, index) => (
                    <li key={index}>{point}</li>
                  ))}
                </ul>
              )}
              {guest.uncertainty.length > 0 && (
                <p className="muted">Uncertainty: {guest.uncertainty.join("; ")}</p>
              )}
              <ReadingDisclosure
                id={`${versionId}-${guest.email}-evidence`}
                label={`Evidence for ${guest.name ?? guest.email}`}
              >
                {guest.evidenceReferences.length ? (
                  <ul>
                    {guest.evidenceReferences.map((value, index) => (
                      <li key={index}>
                        <Source value={value} index={index} />
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="muted">No stored evidence references available.</p>
                )}
              </ReadingDisclosure>
            </li>
          ))}
        </ul>
      )}
      <h3>Companies</h3>
      {brief.companies.length === 0 ? (
        <p className="muted">No company context recorded.</p>
      ) : (
        <ul>
          {brief.companies.map((company) => (
            <li key={company.name}>
              <h4>
                {company.name}
                {company.domain ? ` · ${company.domain}` : ""}
              </h4>
              {company.hubspotContext && <p>{company.hubspotContext}</p>}
              {company.news.length > 0 && <p>News: {company.news.join(" · ")}</p>}
              {company.industry.length > 0 && <p>Industry: {company.industry.join(" · ")}</p>}
              {company.uncertainty.length > 0 && (
                <p className="muted">Uncertainty: {company.uncertainty.join("; ")}</p>
              )}
              {company.docs.length > 0 && (
                <ReadingDisclosure
                  id={`${versionId}-${company.name}-docs`}
                  label={`Documents for ${company.name}`}
                >
                  <ul>
                    {company.docs.map((value, index) => (
                      <li key={index}>
                        <Source value={value} index={index} />
                      </li>
                    ))}
                  </ul>
                </ReadingDisclosure>
              )}
            </li>
          ))}
        </ul>
      )}
      <h3>Sources</h3>
      {brief.sourceReferences.length ? (
        <ReadingDisclosure
          id={`${versionId}-sources`}
          label={`Available sources (${brief.sourceReferences.length})`}
        >
          <ul>
            {brief.sourceReferences.map((value, index) => (
              <li key={index}>
                <Source value={value} index={index} />
              </li>
            ))}
          </ul>
        </ReadingDisclosure>
      ) : (
        <p className="muted">No stored source references available.</p>
      )}
    </div>
  );
}
