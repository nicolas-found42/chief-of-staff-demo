import type {
  HubSpotCompany,
  HubSpotContact,
  HubSpotEnrichmentArtifact,
  MeetingBriefEnrichmentSection,
} from "@chief-of-staff-demo/shared";
import { HUBSPOT_MAX_RESULTS } from "@chief-of-staff-demo/shared";
import type { HubSpotApi } from "./client.js";
import type { RunContext } from "../../../engine/module.js";

function stableRefFor(
  eventVersion: string,
  guestEmail: string,
  source: HubSpotEnrichmentArtifact["source"],
  extra?: string,
): string {
  const base = `${eventVersion}::${guestEmail.toLowerCase()}::${source}`;
  return extra ? `${base}::${extra}` : base;
}

function artifactKey(
  eventVersion: string,
  guestEmail: string,
  source: HubSpotEnrichmentArtifact["source"],
  extra?: string,
): string {
  return stableRefFor(eventVersion, guestEmail, source, extra);
}

function fileNameForArtifact(artifact: HubSpotEnrichmentArtifact): string {
  const sanitized = artifact.guestEmail.replace(/[^a-zA-Z0-9]/g, "_");
  const extra = artifact.companyId ?? artifact.dealId ?? "";
  const suffix = extra ? `-${extra}` : "";
  return `hubspot-${artifact.eventVersion}-${sanitized}-${artifact.source}${suffix}.json`;
}

function readErrorStatus(error: unknown): number | null {
  if (error && typeof error === "object" && "status" in error) {
    const value = (error as Record<string, unknown>).status;
    if (typeof value === "number") return value;
  }
  return null;
}

function readErrorCategory(error: unknown): string | null {
  if (error && typeof error === "object" && "category" in error) {
    const value = (error as Record<string, unknown>).category;
    if (typeof value === "string") return value;
  }
  return null;
}

export async function enrichGuestWithHubSpot(
  api: HubSpotApi,
  eventVersion: string,
  guestEmail: string,
  ctx?: Pick<RunContext, "writeFile" | "event">,
): Promise<{
  artifacts: HubSpotEnrichmentArtifact[];
  sections: MeetingBriefEnrichmentSection[];
  employerMatch: HubSpotCompany | null;
}> {
  const normalizedEmail = guestEmail.trim().toLowerCase();
  const artifacts: HubSpotEnrichmentArtifact[] = [];
  const sections: MeetingBriefEnrichmentSection[] = [];
  let employerMatch: HubSpotCompany | null = null;

  let contact: HubSpotContact | null | undefined;
  try {
    contact = await api.searchContactByEmail(normalizedEmail);
    if (!contact) {
      const artifact: HubSpotEnrichmentArtifact = {
        key: artifactKey(eventVersion, normalizedEmail, "hubspot-contact"),
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
      artifacts.push(artifact);
      sections.push({
        source: "hubspot-contact",
        guest: normalizedEmail,
        status: "empty",
        evidence: [],
        references: [],
      });
      if (ctx) {
        ctx.writeFile(fileNameForArtifact(artifact), JSON.stringify(artifact, null, 2) + "\n");
        ctx.event("hubspot_contact_empty", { guest: normalizedEmail, eventVersion });
      }
      return { artifacts, sections, employerMatch: null };
    }
    const evidence = [`HubSpot contact ${contact.id} for ${normalizedEmail}`];
    const references = [`https://app.hubspot.com/contacts/${contact.id}`];
    const artifact: HubSpotEnrichmentArtifact = {
      key: artifactKey(eventVersion, normalizedEmail, "hubspot-contact"),
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
    artifacts.push(artifact);
    sections.push({
      source: "hubspot-contact",
      guest: normalizedEmail,
      status: "completed",
      evidence,
      references,
    });
    if (ctx) {
      ctx.writeFile(fileNameForArtifact(artifact), JSON.stringify(artifact, null, 2) + "\n");
      ctx.event("hubspot_contact_found", { guest: normalizedEmail, contactId: contact.id });
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const statusCode = readErrorStatus(error);
    const artifact: HubSpotEnrichmentArtifact = {
      key: artifactKey(eventVersion, normalizedEmail, "hubspot-contact"),
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
        errorCode: readErrorCategory(error),
        reason: detail.slice(0, 500),
      },
      stableRef: stableRefFor(eventVersion, normalizedEmail, "hubspot-contact"),
    };
    artifacts.push(artifact);
    sections.push({
      source: "hubspot-contact",
      guest: normalizedEmail,
      status: "failed",
      evidence: [],
      references: [],
    });
    if (ctx) {
      ctx.writeFile(fileNameForArtifact(artifact), JSON.stringify(artifact, null, 2) + "\n");
      ctx.event("hubspot_contact_failed", { guest: normalizedEmail, error: detail });
    }
    return { artifacts, sections, employerMatch: null };
  }

  let companyIds: string[];
  try {
    companyIds = await api.getAssociatedCompanyIds(contact.id);
    companyIds = companyIds.slice(0, HUBSPOT_MAX_RESULTS);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const statusCode = readErrorStatus(error);
    const artifact: HubSpotEnrichmentArtifact = {
      key: artifactKey(eventVersion, normalizedEmail, "hubspot-company"),
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
        errorCode: readErrorCategory(error),
        reason: detail.slice(0, 500),
      },
      stableRef: stableRefFor(eventVersion, normalizedEmail, "hubspot-company"),
    };
    artifacts.push(artifact);
    sections.push({
      source: "hubspot-company",
      guest: normalizedEmail,
      status: "failed",
      evidence: [],
      references: [],
    });
    if (ctx) {
      ctx.writeFile(fileNameForArtifact(artifact), JSON.stringify(artifact, null, 2) + "\n");
      ctx.event("hubspot_company_failed", { guest: normalizedEmail, error: detail });
    }
    companyIds = [];
  }

  if (companyIds.length === 0) {
    const emptyArtifact: HubSpotEnrichmentArtifact = {
      key: artifactKey(eventVersion, normalizedEmail, "hubspot-company"),
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
    artifacts.push(emptyArtifact);
    sections.push({
      source: "hubspot-company",
      guest: normalizedEmail,
      status: "empty",
      evidence: [],
      references: [],
    });
    if (ctx) {
      ctx.writeFile(
        fileNameForArtifact(emptyArtifact),
        JSON.stringify(emptyArtifact, null, 2) + "\n",
      );
    }
  } else {
    for (const companyId of companyIds) {
      try {
        const company = await api.getCompany(companyId);
        if (!company) {
          const empty: HubSpotEnrichmentArtifact = {
            key: artifactKey(eventVersion, normalizedEmail, "hubspot-company", companyId),
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
          artifacts.push(empty);
          sections.push({
            source: "hubspot-company",
            company: companyId,
            guest: normalizedEmail,
            status: "empty",
            evidence: [],
            references: [],
          });
          if (ctx) ctx.writeFile(fileNameForArtifact(empty), JSON.stringify(empty, null, 2) + "\n");
          continue;
        }
        if (!employerMatch) employerMatch = company;
        const evidence = [
          `HubSpot company ${company.name} (${company.id}) associated to ${normalizedEmail}`,
        ];
        const references = [`https://app.hubspot.com/companies/${company.id}`];
        const artifact: HubSpotEnrichmentArtifact = {
          key: artifactKey(eventVersion, normalizedEmail, "hubspot-company", companyId),
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
        artifacts.push(artifact);
        sections.push({
          source: "hubspot-company",
          company: company.name,
          guest: normalizedEmail,
          status: "completed",
          evidence,
          references,
        });
        if (ctx)
          ctx.writeFile(fileNameForArtifact(artifact), JSON.stringify(artifact, null, 2) + "\n");
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const statusCode = readErrorStatus(error);
        const failed: HubSpotEnrichmentArtifact = {
          key: artifactKey(eventVersion, normalizedEmail, "hubspot-company", companyId),
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
            errorCode: readErrorCategory(error),
            reason: detail.slice(0, 500),
          },
          stableRef: stableRefFor(eventVersion, normalizedEmail, "hubspot-company", companyId),
        };
        artifacts.push(failed);
        sections.push({
          source: "hubspot-company",
          company: companyId,
          guest: normalizedEmail,
          status: "failed",
          evidence: [],
          references: [],
        });
        if (ctx) ctx.writeFile(fileNameForArtifact(failed), JSON.stringify(failed, null, 2) + "\n");
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
      } catch {
        // per-company deal association failure is non-fatal
      }
    }
    dealIds = dealIds.slice(0, HUBSPOT_MAX_RESULTS);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const statusCode = readErrorStatus(error);
    const failed: HubSpotEnrichmentArtifact = {
      key: artifactKey(eventVersion, normalizedEmail, "hubspot-deal"),
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
        errorCode: readErrorCategory(error),
        reason: detail.slice(0, 500),
      },
      stableRef: stableRefFor(eventVersion, normalizedEmail, "hubspot-deal"),
    };
    artifacts.push(failed);
    sections.push({
      source: "hubspot-deal",
      guest: normalizedEmail,
      status: "failed",
      evidence: [],
      references: [],
    });
    if (ctx) ctx.writeFile(fileNameForArtifact(failed), JSON.stringify(failed, null, 2) + "\n");
    return { artifacts, sections, employerMatch };
  }

  if (dealIds.length === 0) {
    const empty: HubSpotEnrichmentArtifact = {
      key: artifactKey(eventVersion, normalizedEmail, "hubspot-deal"),
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
    artifacts.push(empty);
    sections.push({
      source: "hubspot-deal",
      guest: normalizedEmail,
      status: "empty",
      evidence: [],
      references: [],
    });
    if (ctx) ctx.writeFile(fileNameForArtifact(empty), JSON.stringify(empty, null, 2) + "\n");
  } else {
    for (const dealId of dealIds) {
      try {
        const deal = await api.getDeal(dealId);
        if (!deal) {
          const empty: HubSpotEnrichmentArtifact = {
            key: artifactKey(eventVersion, normalizedEmail, "hubspot-deal", dealId),
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
          artifacts.push(empty);
          sections.push({
            source: "hubspot-deal",
            guest: normalizedEmail,
            status: "empty",
            evidence: [],
            references: [],
          });
          if (ctx) ctx.writeFile(fileNameForArtifact(empty), JSON.stringify(empty, null, 2) + "\n");
          continue;
        }
        const evidence = [`HubSpot deal ${deal.name ?? deal.id} (${deal.id})`];
        const references = [`https://app.hubspot.com/deals/${deal.id}`];
        const artifact: HubSpotEnrichmentArtifact = {
          key: artifactKey(eventVersion, normalizedEmail, "hubspot-deal", dealId),
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
        artifacts.push(artifact);
        sections.push({
          source: "hubspot-deal",
          guest: normalizedEmail,
          status: "completed",
          evidence,
          references,
        });
        if (ctx)
          ctx.writeFile(fileNameForArtifact(artifact), JSON.stringify(artifact, null, 2) + "\n");
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const statusCode = readErrorStatus(error);
        const failed: HubSpotEnrichmentArtifact = {
          key: artifactKey(eventVersion, normalizedEmail, "hubspot-deal", dealId),
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
            errorCode: readErrorCategory(error),
            reason: detail.slice(0, 500),
          },
          stableRef: stableRefFor(eventVersion, normalizedEmail, "hubspot-deal", dealId),
        };
        artifacts.push(failed);
        sections.push({
          source: "hubspot-deal",
          guest: normalizedEmail,
          status: "failed",
          evidence: [],
          references: [],
        });
        if (ctx) ctx.writeFile(fileNameForArtifact(failed), JSON.stringify(failed, null, 2) + "\n");
      }
    }
  }

  return { artifacts, sections, employerMatch };
}
