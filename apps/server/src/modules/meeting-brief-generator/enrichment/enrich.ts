/* eslint-disable @typescript-eslint/no-unnecessary-condition -- enrichment helpers deliberately handle nullable provider errors */
import type {
  GuestProfileArtifact,
  HubSpotCompany,
  HubSpotContact,
  HubSpotDeal,
  HubSpotEnrichmentArtifact,
  MeetingBriefEnrichmentSection,
  MeetingBriefEvent,
} from "@chief-of-staff-demo/shared";
import {
  GUEST_PROFILE_PROVIDER_ID,
  isGuestProfileEmployerMatch,
} from "@chief-of-staff-demo/shared";
import { meetingBriefOccurrenceIdentity } from "@chief-of-staff-demo/shared";
import { extractDomain, isConsumerDomain, isExternalGuest } from "../eligibility.js";
import type { GmailProvider } from "../google/gmail.js";
import { enrichGmailExact, enrichGmailCompanyDomain } from "../google/gmail.js";
import type { CalendarHistoryProvider } from "../google/calendarHistory.js";
import { enrichCalendarHistory } from "../google/calendarHistory.js";
import type { DriveProvider } from "../google/drive.js";
import { enrichDriveDocs } from "../google/drive.js";
import type { GuestProfileProvider } from "../profile/provider.js";
import type { HubSpotApi } from "../hubspot/client.js";
import { enrichGuestWithHubSpot } from "../hubspot/enrichment.js";
import type { PublicIntelligenceProvider } from "./publicIntelligence.js";
import {
  enrichCompanyNews,
  enrichIndustryNews,
  enrichEmployerVerification,
} from "./publicIntelligence.js";
import type { RunContext } from "../../../engine/module.js";
import { StageFailure } from "../../../engine/module.js";
import {
  deduplicateEvidence,
  readErrorStatus,
  sanitizeEvidence,
  withBoundedRetry,
} from "./helpers.js";
// ---------------------------------------------------------------------------
// Unified enrich deps — all providers injectable fakes
// ---------------------------------------------------------------------------
export interface MeetingBriefEnrichmentProviders {
  gmailProvider?: GmailProvider | null;
  calendarHistoryProvider?: CalendarHistoryProvider | null;
  driveProvider?: DriveProvider | null;
  profileProvider?: GuestProfileProvider | null;
  getHubSpotApi?: (() => HubSpotApi | null) | null;
  publicIntelligenceProvider?: PublicIntelligenceProvider | null;
  proposeEmployer?:
    | ((
        guestEmail: string,
        guestName: string | null,
        eventVersion: string,
      ) => Promise<{ name: string; domain: string | null } | null>)
    | null;
}

export interface UnifiedEnrichDeps {
  providers: MeetingBriefEnrichmentProviders;
  internalDomains: string[];
  occurrenceKey?: string;
}

function profileSection(
  artifact: GuestProfileArtifact,
  guestEmail: string,
): MeetingBriefEnrichmentSection {
  return {
    source: GUEST_PROFILE_PROVIDER_ID,
    guest: guestEmail.toLowerCase(),
    status: artifact.outcome,
    evidence:
      artifact.outcome === "completed"
        ? [artifact.role, artifact.background, artifact.currentEmployer?.name]
            .filter((value): value is string => Boolean(value))
            .map(sanitizeEvidence)
        : [],
    references: artifact.references,
  };
}

// Preservation helpers for hubspot/profile

async function enrichProfileWithRetry(
  provider: GuestProfileProvider,
  guestEmail: string,
  occKey: string,
  eventVersion: string,
  endpoint: string,
  apiKey: string,
  ctx: Pick<RunContext, "writeFile" | "event" | "readFile">,
): Promise<{ artifact: GuestProfileArtifact; section: MeetingBriefEnrichmentSection }> {
  const sanitized = guestEmail.replace(/[^a-zA-Z0-9]/g, "_");
  const filename = `profile-${sanitized}-${eventVersion}.json`;

  const existingRaw = ctx.readFile(filename);
  if (existingRaw) {
    try {
      const existing = JSON.parse(existingRaw) as GuestProfileArtifact;
      if (
        existing.eventVersion === eventVersion &&
        (existing.outcome === "completed" || existing.outcome === "empty")
      ) {
        return { artifact: existing, section: profileSection(existing, guestEmail) };
      }
    } catch {
      // ignore
    }
  }

  const outcome = await withBoundedRetry({
    attempt: () =>
      provider.lookup({
        guestEmail,
        endpoint,
        apiKey,
        occurrenceKey: occKey,
        eventVersion,
      }),
    onRetry: (_error, attempt) =>
      ctx.event("guest_profile_retry", { guest: guestEmail.toLowerCase(), attempt }),
  });
  if (!outcome.ok) {
    // After bounded retry, keep an explicit per-guest failed artifact; only provider-wide
    // failures throw (issue #80 US67/US68).
    const error = outcome.error;
    const attemptedAt = new Date().toISOString();
    const failedArtifact: GuestProfileArtifact = {
      guestEmail: guestEmail.toLowerCase(),
      occurrenceKey: occKey,
      eventVersion,
      source: GUEST_PROFILE_PROVIDER_ID,
      outcome: "failed",
      identityConfidence: null,
      role: null,
      background: null,
      currentEmployer: null,
      references: [],
      diagnostics: {
        provider: "Guest Profile",
        endpoint,
        attemptedAt,
        error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
        ...(readErrorStatus(error) ? { statusCode: readErrorStatus(error)! } : {}),
      },
    };
    ctx.writeFile(filename, JSON.stringify(failedArtifact, null, 2) + "\n");
    const section: MeetingBriefEnrichmentSection = {
      source: GUEST_PROFILE_PROVIDER_ID,
      guest: guestEmail.toLowerCase(),
      status: "failed",
      evidence: [],
      references: [],
    };
    return { artifact: failedArtifact, section };
  }
  const artifact = outcome.value;
  ctx.writeFile(filename, JSON.stringify(artifact, null, 2) + "\n");
  const section = profileSection(artifact, guestEmail);
  ctx.event("guest_profile_enriched", {
    guest: guestEmail.toLowerCase(),
    outcome: artifact.outcome,
    employerMatch: isGuestProfileEmployerMatch(artifact),
  });
  return { artifact, section };
}

async function enrichHubSpotWithRetry(
  api: HubSpotApi,
  eventVersion: string,
  guestEmail: string,
  ctx: Pick<RunContext, "writeFile" | "event" | "readFile">,
): Promise<{
  artifacts: HubSpotEnrichmentArtifact[];
  sections: MeetingBriefEnrichmentSection[];
  employerMatch: HubSpotCompany | null;
}> {
  const sanitized = guestEmail.toLowerCase().replace(/[^a-zA-Z0-9]/g, "_");
  const checkpointFilename = `hubspot-${eventVersion}-${sanitized}-checkpoint.json`;
  interface HubSpotCheckpointCache {
    contact?: HubSpotContact | null;
    companyIds?: string[];
    companies: Record<string, HubSpotCompany | null>;
    contactDealIds?: string[];
    companyDealIds: Record<string, string[]>;
    deals: Record<string, HubSpotDeal | null>;
  }
  type HubSpotCheckpoint = {
    eventVersion: string;
    cache: HubSpotCheckpointCache;
    artifacts: HubSpotEnrichmentArtifact[];
    sections: MeetingBriefEnrichmentSection[];
    employerMatch: HubSpotCompany | null;
  };
  let prior: HubSpotCheckpoint | null = null;
  const existingRaw = ctx.readFile(checkpointFilename);
  if (existingRaw) {
    try {
      const existing = JSON.parse(existingRaw) as HubSpotCheckpoint;
      prior = existing.eventVersion === eventVersion ? existing : null;
      if (
        prior &&
        existing.artifacts.length > 0 &&
        existing.artifacts.every(
          (artifact) => artifact.status === "completed" || artifact.status === "empty",
        )
      ) {
        return {
          artifacts: existing.artifacts,
          sections: existing.sections,
          employerMatch: existing.employerMatch,
        };
      }
    } catch {
      // ignore parse failure, fall through to API call
    }
  }

  const cache: HubSpotCheckpointCache = prior?.cache ?? {
    companies: {},
    companyDealIds: {},
    deals: {},
  };
  const cachedApi: HubSpotApi = {
    listContacts: (limit) => api.listContacts(limit),
    async searchContactByEmail(email) {
      if ("contact" in cache) return cache.contact ?? null;
      const value = await api.searchContactByEmail(email);
      cache.contact = value;
      return value;
    },
    async getAssociatedCompanyIds(contactId) {
      if (cache.companyIds) return cache.companyIds;
      const value = await api.getAssociatedCompanyIds(contactId);
      cache.companyIds = value;
      return value;
    },
    async getCompany(companyId) {
      if (Object.hasOwn(cache.companies, companyId)) return cache.companies[companyId] ?? null;
      const value = await api.getCompany(companyId);
      cache.companies[companyId] = value;
      return value;
    },
    async getAssociatedDealIds(contactId) {
      if (cache.contactDealIds) return cache.contactDealIds;
      const value = await api.getAssociatedDealIds(contactId);
      cache.contactDealIds = value;
      return value;
    },
    async getAssociatedDealIdsForCompany(companyId) {
      if (Object.hasOwn(cache.companyDealIds, companyId)) return cache.companyDealIds[companyId]!;
      const value = await api.getAssociatedDealIdsForCompany(companyId);
      cache.companyDealIds[companyId] = value;
      return value;
    },
    async getDeal(dealId) {
      if (Object.hasOwn(cache.deals, dealId)) return cache.deals[dealId] ?? null;
      const value = await api.getDeal(dealId);
      cache.deals[dealId] = value;
      return value;
    },
  };

  const outcome = await withBoundedRetry({
    attempt: (_attemptNumber, finalAttempt) =>
      enrichGuestWithHubSpot(cachedApi, eventVersion, guestEmail, ctx, { finalAttempt }),
    onRetry: (_error, attempt) =>
      ctx.event("hubspot_retry", { guest: guestEmail.toLowerCase(), attempt }),
    onProviderWide: () => {
      ctx.writeFile(
        checkpointFilename,
        JSON.stringify(
          {
            eventVersion,
            cache,
            artifacts: prior?.artifacts ?? [],
            sections: prior?.sections ?? [],
            employerMatch: prior?.employerMatch ?? null,
          },
          null,
          2,
        ) + "\n",
      );
    },
  });
  if (!outcome.ok) {
    // Preserve an explicit source gap when a non-provider-wide error exhausts its bounded retry.
    const error = outcome.error;
    const failedArtifact: HubSpotEnrichmentArtifact = {
      key: `${eventVersion}::${guestEmail.toLowerCase()}::hubspot-contact`,
      eventVersion,
      guestEmail: guestEmail.toLowerCase(),
      source: "hubspot-contact",
      status: "failed",
      evidence: [],
      references: [],
      diagnostics: {
        bounded: true,
        maxResults: 10,
        stableRef: `${eventVersion}::${guestEmail.toLowerCase()}::hubspot-contact`,
        httpStatus: readErrorStatus(error),
        errorCode: null,
        reason: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
      },
      stableRef: `${eventVersion}::${guestEmail.toLowerCase()}::hubspot-contact`,
    };
    const failedFilename = `hubspot-${eventVersion}-${sanitized}-hubspot-contact.json`;
    ctx.writeFile(failedFilename, JSON.stringify(failedArtifact, null, 2) + "\n");
    return {
      artifacts: [failedArtifact],
      sections: [
        {
          source: "hubspot-contact",
          guest: guestEmail.toLowerCase(),
          status: "failed",
          evidence: [],
          references: [],
        },
      ],
      employerMatch: null,
    };
  }
  const result = outcome.value;
  ctx.writeFile(
    checkpointFilename,
    JSON.stringify({ eventVersion, cache, ...result }, null, 2) + "\n",
  );
  return result;
}

export async function enrichUnified(
  event: MeetingBriefEvent,
  ctx: Pick<RunContext, "writeFile" | "event" | "readFile">,
  deps: UnifiedEnrichDeps,
): Promise<{ sections: MeetingBriefEnrichmentSection[]; evidence: string[] }> {
  const providers = deps.providers;
  const hubSpotApi = providers.getHubSpotApi?.() ?? null;
  const internalDomains = deps.internalDomains ?? [];
  const externalAttendees = event.attendees.filter(
    (a) => !a.resource && isExternalGuest(a, internalDomains),
  );
  const allSections: MeetingBriefEnrichmentSection[] = [];
  const occurrenceKey =
    deps.occurrenceKey ??
    meetingBriefOccurrenceIdentity(event.eventId, event.occurrenceId).occurrenceKey;
  const eventVersion = event.version;
  const eventStartAt = event.startAt;

  // Spec A: fail when required enrichment class wholly unavailable (rejected/missing_configuration/provider-wide outage)
  if (externalAttendees.length > 0) {
    const missing: string[] = [];
    if (!providers.gmailProvider) missing.push("gmail");
    if (!providers.calendarHistoryProvider) missing.push("calendarHistory");
    if (!providers.driveProvider) missing.push("drive");
    if (!providers.profileProvider) missing.push("guestProfile");
    if (!hubSpotApi) missing.push("hubSpot");
    if (!providers.publicIntelligenceProvider) missing.push("publicIntelligence");
    if (missing.length > 0) {
      throw new StageFailure(
        "enrich",
        `missing_configuration: required providers unavailable: ${missing.join(", ")}`,
      );
    }
  }

  // For each external guest, process all sources
  for (const attendee of externalAttendees) {
    const guestEmail = attendee.email;
    const guestName = attendee.displayName ?? null;
    const domain = extractDomain(guestEmail) ?? "";
    const lowerDomain = domain.toLowerCase();
    const isConsumer = isConsumerDomain(lowerDomain);
    const isInternal = internalDomains.map((d) => d.toLowerCase()).includes(lowerDomain);

    // 1. Gmail exact
    if (providers.gmailProvider) {
      const { section } = await enrichGmailExact(
        providers.gmailProvider,
        eventVersion,
        guestEmail,
        ctx,
      );
      allSections.push(section);
    }

    // 2. Gmail company-domain for non-Consumer non-Internal
    if (providers.gmailProvider && domain && !isConsumer && !isInternal) {
      const { section } = await enrichGmailCompanyDomain(
        providers.gmailProvider,
        eventVersion,
        guestEmail,
        lowerDomain,
        ctx,
      );
      allSections.push(section);
    }

    // 3. Calendar history
    if (providers.calendarHistoryProvider) {
      const { section } = await enrichCalendarHistory(
        providers.calendarHistoryProvider,
        eventVersion,
        guestEmail,
        eventStartAt,
        ctx,
      );
      allSections.push(section);
    }

    // 4. Drive docs
    if (providers.driveProvider) {
      const companyForDrive = !isConsumer && !isInternal && domain ? lowerDomain : null;
      const { section } = await enrichDriveDocs(
        providers.driveProvider,
        eventVersion,
        guestEmail,
        companyForDrive,
        ctx,
      );
      allSections.push(section);
    }

    // 5. Guest Profile
    let profileArtifact: GuestProfileArtifact | null = null;
    let profileEmployerMatch: { name: string; domain: string | null } | null = null;
    if (providers.profileProvider) {
      const { artifact, section } = await enrichProfileWithRetry(
        providers.profileProvider,
        guestEmail,
        occurrenceKey,
        eventVersion,
        "",
        "",
        ctx,
      );
      profileArtifact = artifact;
      if (isGuestProfileEmployerMatch(artifact) && artifact.currentEmployer) {
        profileEmployerMatch = {
          name: artifact.currentEmployer.name,
          domain: artifact.currentEmployer.domain,
        };
      }
      allSections.push(section);
    }

    // 6. HubSpot
    let hubspotCompany: HubSpotCompany | null = null;
    if (hubSpotApi) {
      const { sections, employerMatch } = await enrichHubSpotWithRetry(
        hubSpotApi,
        eventVersion,
        guestEmail,
        ctx,
      );
      hubspotCompany = employerMatch;
      allSections.push(...sections);
    }

    // 7. Employer Match resolution
    let employerMatch: { name: string; domain: string | null; source: string } | null = null;
    let employerMatchEvidence: string[] = [];
    let employerMatchReferences: string[] = [];

    if (hubspotCompany) {
      employerMatch = {
        name: hubspotCompany.name,
        domain: hubspotCompany.domain,
        source: "hubspot",
      };
      employerMatchEvidence = [
        `HubSpot company ${hubspotCompany.name} associated to ${guestEmail}`,
      ];
      employerMatchReferences = [`https://app.hubspot.com/companies/${hubspotCompany.id}`];
    } else if (profileEmployerMatch) {
      employerMatch = {
        name: profileEmployerMatch.name,
        domain: profileEmployerMatch.domain,
        source: "profile",
      };
      employerMatchEvidence = profileArtifact?.currentEmployer?.evidence ?? [];
      employerMatchReferences = profileArtifact?.references ?? [];
    } else if (providers.proposeEmployer && providers.publicIntelligenceProvider) {
      // Model proposes candidate to drive research
      const candidate = await providers.proposeEmployer(guestEmail, guestName, eventVersion);
      if (candidate) {
        const candName = candidate.name.trim();
        const candDomain = candidate.domain?.trim() ?? null;
        // Bounded research via public search, two-org rule
        const { artifact, section, verified } = await enrichEmployerVerification(
          providers.publicIntelligenceProvider,
          eventVersion,
          guestEmail,
          guestName,
          candName,
          candDomain,
          eventStartAt,
          ctx,
        );
        allSections.push(section);
        if (verified) {
          employerMatch = { name: candName, domain: candDomain, source: "verified-candidate" };
          employerMatchEvidence = artifact.evidence;
          employerMatchReferences = artifact.references;
          allSections.push({
            source: "employer-match",
            guest: guestEmail.toLowerCase(),
            company: candName,
            status: "completed",
            evidence: employerMatchEvidence,
            references: employerMatchReferences,
          });
        }
      }
    }

    // Direct provider evidence records the accepted employer relationship explicitly.
    if (
      employerMatch &&
      (employerMatch.source === "hubspot" || employerMatch.source === "profile")
    ) {
      const existingMatchSection = allSections.find(
        (s) => s.source === "employer-match" && s.guest === guestEmail.toLowerCase(),
      );
      if (!existingMatchSection) {
        allSections.push({
          source: "employer-match",
          guest: guestEmail.toLowerCase(),
          company: employerMatch.name,
          status: "completed",
          evidence: employerMatchEvidence,
          references: employerMatchReferences,
        });
      }
    }

    // Accepted matches unlock bounded company and industry intelligence.
    if (employerMatch && providers.publicIntelligenceProvider) {
      const companyName = employerMatch.name;
      const companyDomain = employerMatch.domain;

      const { section: companyNews } = await enrichCompanyNews(
        providers.publicIntelligenceProvider,
        eventVersion,
        guestEmail,
        companyName,
        companyDomain,
        eventStartAt,
        ctx,
      );
      allSections.push(companyNews);

      const { section: industryNews } = await enrichIndustryNews(
        providers.publicIntelligenceProvider,
        eventVersion,
        guestEmail,
        companyName,
        companyDomain,
        eventStartAt,
        ctx,
      );
      allSections.push(industryNews);
    }
  }

  // Normalize + deduplicate all evidence while preserving source ownership/refs
  // Per-artifact dedup already done, now global dedup for enrich.json evidence
  const rawEvidence = allSections.flatMap((s) => s.evidence);
  const normalized = rawEvidence.map(sanitizeEvidence).filter(Boolean);
  const globalDeduped = deduplicateEvidence(normalized);

  // Also deduplicate sections' evidence per source preserving ownership: each section's evidence already deduped per artifact, but we ensure per-section dedup as well
  const dedupedSections = allSections.map((section) => {
    const deduped = deduplicateEvidence(section.evidence.map(sanitizeEvidence));
    return { ...section, evidence: deduped };
  });

  // Persist aggregated enrich.json with normalized deduped evidence
  // The caller will write enrich.json, but we return sections and evidence
  return { sections: dedupedSections, evidence: globalDeduped };
}
