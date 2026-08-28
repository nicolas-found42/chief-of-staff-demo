import type {
  MeetingBriefEnrichmentSection,
  MeetingBriefFixtureEvent,
} from "@chief-of-staff-demo/shared";
import type { GoogleEnrichmentArtifact } from "@chief-of-staff-demo/shared";
import { extractDomain, isConsumerDomain, isExternalGuest } from "../eligibility.js";
import type { GmailProvider } from "../google/gmail.js";
import { enrichGmailExact, enrichGmailCompanyDomain } from "../google/gmail.js";
import type { CalendarHistoryProvider } from "../google/calendarHistory.js";
import { enrichCalendarHistory } from "../google/calendarHistory.js";
import type { DriveProvider } from "../google/drive.js";
import { enrichDriveDocs } from "../google/drive.js";
import type { RunContext } from "../../../engine/module.js";

export interface GoogleEnrichmentDeps {
  gmailProvider: GmailProvider;
  calendarProvider: CalendarHistoryProvider;
  driveProvider: DriveProvider;
  internalDomains: string[];
}

export interface GoogleEnrichmentResult {
  artifacts: GoogleEnrichmentArtifact[];
  sections: MeetingBriefEnrichmentSection[];
}

export async function enrichWithGoogle(
  event: MeetingBriefFixtureEvent,
  ctx: Pick<RunContext, "writeFile" | "event" | "readFile">,
  deps: GoogleEnrichmentDeps,
): Promise<GoogleEnrichmentResult> {
  const version = event.version;
  const before = event.startAt;
  const artifacts: GoogleEnrichmentArtifact[] = [];
  const sections: MeetingBriefEnrichmentSection[] = [];

  // Determine external guests (exclude resources)
  const externalGuests = event.attendees.filter(
    (a) => !a.resource && isExternalGuest(a, deps.internalDomains),
  );
  // Keep guest with no Employer Match person-level — no filtering, keep all external
  // No company inference for Consumer Domains handled below

  for (const attendee of externalGuests) {
    const guestEmail = attendee.email;
    const domain = extractDomain(guestEmail);
    const isConsumer = domain ? isConsumerDomain(domain) : false;

    // 1. Gmail exact-address (at most 10)
    try {
      const { artifact, section } = await enrichGmailExact(
        deps.gmailProvider,
        version,
        guestEmail,
        ctx,
      );
      artifacts.push(artifact);
      sections.push(section);
    } catch (error) {
      // Provider-wide failure should bubble to fail enrich stage
      if (isProviderWide(error)) throw error;
      // Should not reach here because enrichGmailExact handles individual failures as artifact
      throw error;
    }

    // 2. Gmail company-domain for non-Consumer (bounded)
    if (domain && !isConsumer) {
      // Company domain is the guest's domain unless internal — but external guest means not internal, so use domain
      // Check not internal (redundant)
      const lowerDomain = domain.toLowerCase();
      const isInternal = deps.internalDomains.map((d) => d.toLowerCase()).includes(lowerDomain);
      if (!isInternal) {
        try {
          const { artifact, section } = await enrichGmailCompanyDomain(
            deps.gmailProvider,
            version,
            guestEmail,
            lowerDomain,
            ctx,
          );
          artifacts.push(artifact);
          sections.push(section);
        } catch (error) {
          if (isProviderWide(error)) throw error;
          throw error;
        }
      }
    }

    // 3. Calendar history — 10 prior meetings
    try {
      const { artifact, section } = await enrichCalendarHistory(
        deps.calendarProvider,
        version,
        guestEmail,
        before,
        ctx,
      );
      artifacts.push(artifact);
      sections.push(section);
    } catch (error) {
      if (isProviderWide(error)) throw error;
      throw error;
    }

    // 4. Drive docs — bounded relevant Docs
    // For consumer domains, keep person-level only (no company inference)
    const companyForDrive = !isConsumer && domain ? domain.toLowerCase() : null;
    // Also ensure not internal
    const finalCompany = (() => {
      if (!companyForDrive) return null;
      const lower = companyForDrive;
      if (deps.internalDomains.map((d) => d.toLowerCase()).includes(lower)) return null;
      return lower;
    })();
    try {
      const { artifact, section } = await enrichDriveDocs(
        deps.driveProvider,
        version,
        guestEmail,
        finalCompany,
        ctx,
      );
      artifacts.push(artifact);
      sections.push(section);
    } catch (error) {
      if (isProviderWide(error)) throw error;
      throw error;
    }
  }

  return { artifacts, sections };
}

function isProviderWide(error: unknown): boolean {
  const maybe = error as { status?: number; code?: number; response?: { status?: number } };
  const status = maybe.status ?? maybe.code ?? maybe.response?.status;
  const msg = error instanceof Error ? error.message : String(error);
  if (status === 401 || status === 403 || status === 503) return true;
  if (
    /invalid_grant|insufficient authentication scopes|ACCESS_TOKEN_SCOPE_INSUFFICIENT|accessNotConfigured|has not been used in project|is disabled/i.test(
      msg,
    )
  )
    return true;
  return false;
}
