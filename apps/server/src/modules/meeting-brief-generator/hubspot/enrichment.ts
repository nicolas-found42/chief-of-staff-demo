import type {
  HubSpotCompany,
  HubSpotContact,
  HubSpotEnrichmentArtifact,
  MeetingBriefEnrichmentSection,
} from "@chief-of-staff-demo/shared";
import { HUBSPOT_MAX_RESULTS } from "@chief-of-staff-demo/shared";
import type { HubSpotApi } from "./client.js";
import type { RunContext } from "../../../engine/module.js";
import {
  isProviderWideError,
  readErrorCode,
  readErrorStatus,
  sanitizeArtifactVersion,
} from "../enrichment/helpers.js";
import { claimIdFor } from "../freshness.js";

function stableRefFor(
  eventVersion: string,
  guestEmail: string,
  source: HubSpotEnrichmentArtifact["source"],
  extra?: string,
): string {
  const base = `${eventVersion}::${guestEmail.toLowerCase()}::${source}`;
  return extra ? `${base}::${extra}` : base;
}

function fileNameForArtifact(artifact: HubSpotEnrichmentArtifact): string {
  const sanitized = artifact.guestEmail.replace(/[^a-zA-Z0-9]/g, "_");
  const extra = artifact.companyId ?? artifact.dealId ?? "";
  const suffix = extra ? `-${extra}` : "";
  return `hubspot-${sanitizeArtifactVersion(artifact.eventVersion)}-${sanitized}-${artifact.source}${suffix}.json`;
}

function recordArtifact(
  artifacts: HubSpotEnrichmentArtifact[],
  sections: MeetingBriefEnrichmentSection[],
  artifact: HubSpotEnrichmentArtifact,
  ctx: Pick<RunContext, "writeFile"> | undefined,
  company?: string,
  retrievedAt?: string,
  contactEmployer?: string,
): void {
  // The retrieval time belongs to the artifact, so a later same-version Run
  // that reuses this file inherits when the CRM was actually read.
  const persisted: HubSpotEnrichmentArtifact =
    retrievedAt && !artifact.retrievedAt ? { ...artifact, retrievedAt } : artifact;
  artifacts.push(persisted);
  const employerClaim = artifact.isEmployerMatch === true && company !== undefined;
  // A CRM contact states the person's employer when the record carries one;
  // that is the value a Profile-derived employer can contradict.
  const contactClaim = artifact.source === "hubspot-contact" && contactEmployer !== undefined;
  const claimKind =
    employerClaim || contactClaim
      ? "current-employer"
      : artifact.source === "hubspot-contact"
        ? "current-role"
        : "other";
  sections.push({
    source: artifact.source,
    guest: artifact.guestEmail,
    ...(company ? { company } : {}),
    status: artifact.status,
    evidence: artifact.evidence,
    references: artifact.references,
    provenance: {
      retrievedAt: persisted.retrievedAt ?? null,
      publishedAt: null,
      claimId: claimIdFor(claimKind, artifact.guestEmail),
      claimValue: employerClaim ? company : (contactEmployer ?? null),
    },
  });
  ctx?.writeFile(fileNameForArtifact(persisted), JSON.stringify(persisted, null, 2) + "\n");
}

/**
 * Rethrow an error this attempt must not record as a failed artifact. A
 * provider-wide error abandons the whole source, and before the final attempt the
 * bounded retry needs the throw to get its next try — only the last attempt is
 * allowed to settle a guest as failed.
 */
function rethrowUnlessRecordable(error: unknown, options?: { finalAttempt?: boolean }): void {
  if (isProviderWideError(error)) throw error;
  if (options && options.finalAttempt === false) throw error;
}

export async function enrichGuestWithHubSpot(
  api: HubSpotApi,
  eventVersion: string,
  guestEmail: string,
  ctx?: Pick<RunContext, "writeFile" | "event">,
  options?: { finalAttempt?: boolean },
  retrievedAt?: string,
): Promise<{
  artifacts: HubSpotEnrichmentArtifact[];
  sections: MeetingBriefEnrichmentSection[];
  employerMatch: HubSpotCompany | null;
}> {
  const normalizedEmail = guestEmail.trim().toLowerCase();
  const artifacts: HubSpotEnrichmentArtifact[] = [];
  const sections: MeetingBriefEnrichmentSection[] = [];
  const record = (
    artifact: HubSpotEnrichmentArtifact,
    company?: string,
    contactEmployer?: string,
  ): void =>
    recordArtifact(artifacts, sections, artifact, ctx, company, retrievedAt, contactEmployer);
  let employerMatch: HubSpotCompany | null = null;

  let contact: HubSpotContact | null | undefined;
  try {
    contact = await api.searchContactByEmail(normalizedEmail);
    if (!contact) {
      const artifact: HubSpotEnrichmentArtifact = {
        key: stableRefFor(eventVersion, normalizedEmail, "hubspot-contact"),
        eventVersion,
        guestEmail: normalizedEmail,
        source: "hubspot-contact",
        status: "empty",
        evidence: [],
        references: [],
        diagnostics: {
          bounded: true,
          maxResults: HUBSPOT_MAX_RESULTS,
          stableRef: stableRefFor(eventVersion, normalizedEmail, "hubspot-contact"),
          reason: "no_exact_email_match",
        },
        stableRef: stableRefFor(eventVersion, normalizedEmail, "hubspot-contact"),
      };
      record(artifact);
      if (ctx) {
        ctx.event("hubspot_contact_empty", { guest: normalizedEmail, eventVersion });
      }
      return { artifacts, sections, employerMatch: null };
    }
    const evidence = [`HubSpot contact ${contact.id} for ${normalizedEmail}`];
    const references = [`https://app.hubspot.com/contacts/${contact.id}`];
    const artifact: HubSpotEnrichmentArtifact = {
      key: stableRefFor(eventVersion, normalizedEmail, "hubspot-contact"),
      eventVersion,
      guestEmail: normalizedEmail,
      source: "hubspot-contact",
      status: "completed",
      evidence,
      references,
      diagnostics: {
        bounded: true,
        maxResults: HUBSPOT_MAX_RESULTS,
        stableRef: stableRefFor(eventVersion, normalizedEmail, "hubspot-contact"),
      },
      stableRef: stableRefFor(eventVersion, normalizedEmail, "hubspot-contact"),
    };
    record(artifact, undefined, contact.properties["company"]);
    if (ctx) {
      ctx.event("hubspot_contact_found", { guest: normalizedEmail, contactId: contact.id });
    }
  } catch (error) {
    rethrowUnlessRecordable(error, options);
    const detail = error instanceof Error ? error.message : String(error);
    const statusCode = readErrorStatus(error);
    const artifact: HubSpotEnrichmentArtifact = {
      key: stableRefFor(eventVersion, normalizedEmail, "hubspot-contact"),
      eventVersion,
      guestEmail: normalizedEmail,
      source: "hubspot-contact",
      status: "failed",
      evidence: [],
      references: [],
      diagnostics: {
        bounded: true,
        maxResults: HUBSPOT_MAX_RESULTS,
        stableRef: stableRefFor(eventVersion, normalizedEmail, "hubspot-contact"),
        httpStatus: statusCode,
        errorCode: readErrorCode(error),
        reason: detail.slice(0, 500),
      },
      stableRef: stableRefFor(eventVersion, normalizedEmail, "hubspot-contact"),
    };
    record(artifact);
    if (ctx) {
      ctx.event("hubspot_contact_failed", { guest: normalizedEmail, error: detail });
    }
    return { artifacts, sections, employerMatch: null };
  }

  let companyIds: string[];
  try {
    companyIds = await api.getAssociatedCompanyIds(contact.id);
    companyIds = companyIds.slice(0, HUBSPOT_MAX_RESULTS);
  } catch (error) {
    rethrowUnlessRecordable(error, options);
    const detail = error instanceof Error ? error.message : String(error);
    const statusCode = readErrorStatus(error);
    const artifact: HubSpotEnrichmentArtifact = {
      key: stableRefFor(eventVersion, normalizedEmail, "hubspot-company"),
      eventVersion,
      guestEmail: normalizedEmail,
      source: "hubspot-company",
      status: "failed",
      evidence: [],
      references: [],
      diagnostics: {
        bounded: true,
        maxResults: HUBSPOT_MAX_RESULTS,
        stableRef: stableRefFor(eventVersion, normalizedEmail, "hubspot-company"),
        httpStatus: statusCode,
        errorCode: readErrorCode(error),
        reason: detail.slice(0, 500),
      },
      stableRef: stableRefFor(eventVersion, normalizedEmail, "hubspot-company"),
    };
    record(artifact);
    if (ctx) {
      ctx.event("hubspot_company_failed", { guest: normalizedEmail, error: detail });
    }
    companyIds = [];
  }

  if (companyIds.length === 0) {
    const emptyArtifact: HubSpotEnrichmentArtifact = {
      key: stableRefFor(eventVersion, normalizedEmail, "hubspot-company"),
      eventVersion,
      guestEmail: normalizedEmail,
      source: "hubspot-company",
      status: "empty",
      evidence: [],
      references: [],
      diagnostics: {
        bounded: true,
        maxResults: HUBSPOT_MAX_RESULTS,
        stableRef: stableRefFor(eventVersion, normalizedEmail, "hubspot-company"),
        reason: "no_associated_company",
      },
      stableRef: stableRefFor(eventVersion, normalizedEmail, "hubspot-company"),
    };
    record(emptyArtifact);
  } else {
    for (const companyId of companyIds) {
      try {
        const company = await api.getCompany(companyId);
        if (!company) {
          const empty: HubSpotEnrichmentArtifact = {
            key: stableRefFor(eventVersion, normalizedEmail, "hubspot-company", companyId),
            eventVersion,
            guestEmail: normalizedEmail,
            companyId,
            source: "hubspot-company",
            status: "empty",
            evidence: [],
            references: [],
            diagnostics: {
              bounded: true,
              maxResults: HUBSPOT_MAX_RESULTS,
              stableRef: stableRefFor(eventVersion, normalizedEmail, "hubspot-company", companyId),
              reason: "company_not_found",
            },
            stableRef: stableRefFor(eventVersion, normalizedEmail, "hubspot-company", companyId),
          };
          record(empty, companyId);
          continue;
        }
        if (!employerMatch) employerMatch = company;
        const evidence = [
          `HubSpot company ${company.name} (${company.id}) associated to ${normalizedEmail}`,
        ];
        const references = [`https://app.hubspot.com/companies/${company.id}`];
        const artifact: HubSpotEnrichmentArtifact = {
          key: stableRefFor(eventVersion, normalizedEmail, "hubspot-company", companyId),
          eventVersion,
          guestEmail: normalizedEmail,
          companyId,
          source: "hubspot-company",
          status: "completed",
          evidence,
          references,
          diagnostics: {
            bounded: true,
            maxResults: HUBSPOT_MAX_RESULTS,
            stableRef: stableRefFor(eventVersion, normalizedEmail, "hubspot-company", companyId),
            employerMatch: true,
          },
          stableRef: stableRefFor(eventVersion, normalizedEmail, "hubspot-company", companyId),
          isEmployerMatch: true,
        };
        record(artifact, company.name);
      } catch (error) {
        rethrowUnlessRecordable(error, options);
        const detail = error instanceof Error ? error.message : String(error);
        const statusCode = readErrorStatus(error);
        const failed: HubSpotEnrichmentArtifact = {
          key: stableRefFor(eventVersion, normalizedEmail, "hubspot-company", companyId),
          eventVersion,
          guestEmail: normalizedEmail,
          companyId,
          source: "hubspot-company",
          status: "failed",
          evidence: [],
          references: [],
          diagnostics: {
            bounded: true,
            maxResults: HUBSPOT_MAX_RESULTS,
            stableRef: stableRefFor(eventVersion, normalizedEmail, "hubspot-company", companyId),
            httpStatus: statusCode,
            errorCode: readErrorCode(error),
            reason: detail.slice(0, 500),
          },
          stableRef: stableRefFor(eventVersion, normalizedEmail, "hubspot-company", companyId),
        };
        record(failed, companyId);
      }
    }
  }

  let dealIds: string[];
  try {
    const contactDeals = await api.getAssociatedDealIds(contact.id);
    dealIds = [...contactDeals];
    for (const cid of companyIds) {
      try {
        const companyDeals = await api.getAssociatedDealIdsForCompany(cid);
        for (const did of companyDeals) {
          if (!dealIds.includes(did)) dealIds.push(did);
        }
      } catch (error) {
        rethrowUnlessRecordable(error, options);
        // per-company deal association failure is non-fatal on final attempt
      }
    }
    dealIds = dealIds.slice(0, HUBSPOT_MAX_RESULTS);
  } catch (error) {
    rethrowUnlessRecordable(error, options);
    const detail = error instanceof Error ? error.message : String(error);
    const statusCode = readErrorStatus(error);
    const failed: HubSpotEnrichmentArtifact = {
      key: stableRefFor(eventVersion, normalizedEmail, "hubspot-deal"),
      eventVersion,
      guestEmail: normalizedEmail,
      source: "hubspot-deal",
      status: "failed",
      evidence: [],
      references: [],
      diagnostics: {
        bounded: true,
        maxResults: HUBSPOT_MAX_RESULTS,
        stableRef: stableRefFor(eventVersion, normalizedEmail, "hubspot-deal"),
        httpStatus: statusCode,
        errorCode: readErrorCode(error),
        reason: detail.slice(0, 500),
      },
      stableRef: stableRefFor(eventVersion, normalizedEmail, "hubspot-deal"),
    };
    record(failed);
    return { artifacts, sections, employerMatch };
  }

  if (dealIds.length === 0) {
    const empty: HubSpotEnrichmentArtifact = {
      key: stableRefFor(eventVersion, normalizedEmail, "hubspot-deal"),
      eventVersion,
      guestEmail: normalizedEmail,
      source: "hubspot-deal",
      status: "empty",
      evidence: [],
      references: [],
      diagnostics: {
        bounded: true,
        maxResults: HUBSPOT_MAX_RESULTS,
        stableRef: stableRefFor(eventVersion, normalizedEmail, "hubspot-deal"),
        reason: "no_associated_deal",
      },
      stableRef: stableRefFor(eventVersion, normalizedEmail, "hubspot-deal"),
    };
    record(empty);
  } else {
    for (const dealId of dealIds) {
      try {
        const deal = await api.getDeal(dealId);
        if (!deal) {
          const empty: HubSpotEnrichmentArtifact = {
            key: stableRefFor(eventVersion, normalizedEmail, "hubspot-deal", dealId),
            eventVersion,
            guestEmail: normalizedEmail,
            dealId,
            source: "hubspot-deal",
            status: "empty",
            evidence: [],
            references: [],
            diagnostics: {
              bounded: true,
              maxResults: HUBSPOT_MAX_RESULTS,
              stableRef: stableRefFor(eventVersion, normalizedEmail, "hubspot-deal", dealId),
              reason: "deal_not_found",
            },
            stableRef: stableRefFor(eventVersion, normalizedEmail, "hubspot-deal", dealId),
          };
          record(empty);
          continue;
        }
        const evidence = [`HubSpot deal ${deal.name ?? deal.id} (${deal.id})`];
        const references = [`https://app.hubspot.com/deals/${deal.id}`];
        const artifact: HubSpotEnrichmentArtifact = {
          key: stableRefFor(eventVersion, normalizedEmail, "hubspot-deal", dealId),
          eventVersion,
          guestEmail: normalizedEmail,
          dealId,
          source: "hubspot-deal",
          status: "completed",
          evidence,
          references,
          diagnostics: {
            bounded: true,
            maxResults: HUBSPOT_MAX_RESULTS,
            stableRef: stableRefFor(eventVersion, normalizedEmail, "hubspot-deal", dealId),
          },
          stableRef: stableRefFor(eventVersion, normalizedEmail, "hubspot-deal", dealId),
        };
        record(artifact);
      } catch (error) {
        rethrowUnlessRecordable(error, options);
        const detail = error instanceof Error ? error.message : String(error);
        const statusCode = readErrorStatus(error);
        const failed: HubSpotEnrichmentArtifact = {
          key: stableRefFor(eventVersion, normalizedEmail, "hubspot-deal", dealId),
          eventVersion,
          guestEmail: normalizedEmail,
          dealId,
          source: "hubspot-deal",
          status: "failed",
          evidence: [],
          references: [],
          diagnostics: {
            bounded: true,
            maxResults: HUBSPOT_MAX_RESULTS,
            stableRef: stableRefFor(eventVersion, normalizedEmail, "hubspot-deal", dealId),
            httpStatus: statusCode,
            errorCode: readErrorCode(error),
            reason: detail.slice(0, 500),
          },
          stableRef: stableRefFor(eventVersion, normalizedEmail, "hubspot-deal", dealId),
        };
        record(failed);
      }
    }
  }

  return { artifacts, sections, employerMatch };
}
