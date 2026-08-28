import type {
  GuestProfileArtifact,
  MeetingBrief,
  MeetingBriefDeliveryState,
  MeetingBriefFixtureEvent,
  MeetingBriefRunResult,
} from "@chief-of-staff-demo/shared";
import {
  GUEST_PROFILE_PROVIDER_ID,
  MEETING_BRIEF_MODULE_ID,
  MEETING_BRIEF_MODULE_VERSION,
} from "@chief-of-staff-demo/shared";
import type { RunOutcome } from "../../runs.js";
import type { RunContext, ShellModule } from "../../engine/module.js";
import type { GuestProfileProvider } from "./profile/provider.js";
import { isEmployerMatch } from "./profile/provider.js";
import type { GmailProvider } from "./google/gmail.js";
import { enrichGmailCompanyDomain, enrichGmailExact } from "./google/gmail.js";
import type { CalendarHistoryProvider } from "./google/calendarHistory.js";
import { enrichCalendarHistory } from "./google/calendarHistory.js";
import type { DriveProvider } from "./google/drive.js";
import { enrichDriveDocs } from "./google/drive.js";
import { extractDomain, isConsumerDomain, isExternalGuest } from "./eligibility.js";
export type MeetingBriefInput = MeetingBriefFixtureEvent & {
  occurrenceKey: string;
};
export interface MeetingBriefModuleDeps {
  now?: () => Date;
  enrich?: (
    input: MeetingBriefInput,
    ctx: RunContext,
  ) => Promise<{
    sections: unknown[];
    evidence: string[];
  }>;
  completeBrief?: (input: MeetingBriefInput, enrichResult: unknown) => Promise<MeetingBrief>;
  deliver?: (
    brief: MeetingBrief,
    event: MeetingBriefFixtureEvent,
  ) => Promise<{
    messageId: string;
    recipient: string;
  }>;
  invalidateIndex?: () => void;
  profileProvider?: GuestProfileProvider | null;
  guestProfileEndpoint?: string;
  guestProfileApiKey?: string;
  gmailProvider?: GmailProvider | null;
  calendarHistoryProvider?: CalendarHistoryProvider | null;
  driveProvider?: DriveProvider | null;
  internalDomains?: string[];
  getInternalDomains?: () => string[];
}
/**
 * Meeting Brief Generator v1 — 4 fixed Stages (issue://80, ADR-0032/33/34).
 *
 * Stages: snapshot → enrich → compose → deliver (no dynamic names).
 */
export function meetingBriefModule(deps: MeetingBriefModuleDeps): ShellModule<MeetingBriefInput> {
  const now = deps.now ?? (() => new Date());

  return {
    id: MEETING_BRIEF_MODULE_ID,
    version: MEETING_BRIEF_MODULE_VERSION,

    failureHint(stage: string, reason: string): string {
      if (stage === "snapshot") return "The calendar event could not be captured.";
      if (stage === "enrich") return "Enrichment failed — a required provider was unavailable.";
      if (stage === "compose") return "The meeting brief could not be composed.";
      if (stage === "deliver") return "The brief was ready but delivery failed.";
      return reason;
    },

    planRetry(meta) {
      if (meta.status !== "failed" || !meta.failedStage) return null;
      const fromStage = meta.failedStage;
      if (!["snapshot", "enrich", "compose", "deliver"].includes(fromStage)) return null;
      // Reconstruct input from externalId (occurrenceKey) — for fixture we keep retry simple.
      // The Runner will re-enqueue with a fresh input that contains the same externalId.
      // Here we cannot reconstruct full event; host's retry will supply it via meta?
      // For tracer bullet we allow retry from the failed stage with a minimal stub input;
      // the Run's artifacts (snapshot.json) will be consulted.
      return {
        fromStage,
        reason: "failed_stage_is_safe_to_repeat",
        input: {
          calendarId: "retry",
          eventId: meta.externalId ?? "retry",
          occurrenceId: meta.externalId ?? "retry",
          occurrenceKey: meta.externalId ?? "retry",
          version: "retry",
          summary: "retry",
          startAt: now().toISOString(),
          endAt: now().toISOString(),
          attendees: [],
        } as unknown as MeetingBriefInput,
        resetAttempts: false,
      };
    },

    planRecovery(state) {
      if (state.module !== MEETING_BRIEF_MODULE_ID) return null;
      if (state.status !== "pending" && state.status !== "running") return null;
      // Choose first incomplete stage by artifact presence.
      const files = new Set(state.files);
      if (!files.has("snapshot.json"))
        return {
          fromStage: "snapshot",
          reason: "durable_progress_first_incomplete",
          input: state as unknown as MeetingBriefInput,
        };
      if (!files.has("enrich.json"))
        return {
          fromStage: "enrich",
          reason: "durable_progress_first_incomplete",
          input: state as unknown as MeetingBriefInput,
        };
      if (!files.has("result.json"))
        return {
          fromStage: "compose",
          reason: "durable_progress_first_incomplete",
          input: state as unknown as MeetingBriefInput,
        };
      return {
        fromStage: "deliver",
        reason: "durable_progress_first_incomplete",
        input: state as unknown as MeetingBriefInput,
      };
    },

    async run(ctx: RunContext, input: MeetingBriefInput): Promise<RunOutcome> {
      const occurrenceKey = input.occurrenceKey;
      const snapshotAt = now().toISOString();

      // snapshot — freeze event identity + version
      await ctx.stage("snapshot", async () => {
        ctx.event("snapshot_captured", {
          eventId: input.eventId,
          occurrenceId: input.occurrenceId,
          occurrenceKey,
          version: input.version,
          startAt: input.startAt,
        });
        ctx.writeFile(
          "snapshot.json",
          JSON.stringify(
            {
              eventId: input.eventId,
              occurrenceId: input.occurrenceId,
              occurrenceKey,
              version: input.version,
              summary: input.summary,
              startAt: input.startAt,
              endAt: input.endAt,
              attendees: input.attendees,
              capturedAt: snapshotAt,
            },
            null,
            2,
          ) + "\n",
        );
      });

      // enrich — bounded evidence via injected fakes + Guest Profile provider per guest
      let enrichResult: { sections: unknown[]; evidence: string[] } = {
        sections: [],
        evidence: [],
      };
      const profileArtifacts: GuestProfileArtifact[] = [];
      await ctx.stage("enrich", async () => {
        if (deps.enrich) {
          enrichResult = await deps.enrich(input, ctx);
        } else if (deps.gmailProvider || deps.calendarHistoryProvider || deps.driveProvider) {
          // Google bounded enrichment path (issue://85) — static imports, no dynamic import.
          const internalDomains = deps.getInternalDomains ? deps.getInternalDomains() : (deps.internalDomains ?? []);
          const gmailProvider = deps.gmailProvider ?? null;
          const calendarProvider = deps.calendarHistoryProvider ?? null;
          const driveProvider = deps.driveProvider ?? null;

          // Determine external guests (exclude resources, internal domain)
          const externalAttendees = input.attendees.filter((a) => !a.resource && isExternalGuest(a, internalDomains));
          const allSections: unknown[] = [];
          const googleArtifacts: unknown[] = [];

          // For each external guest, run Google enrichment bounded per source
          for (const attendee of externalAttendees) {
            const guestEmail = attendee.email;
            const domain = extractDomain(guestEmail) ?? "";
            const lowerDomain = domain.toLowerCase();
            const isConsumer = isConsumerDomain(lowerDomain);
            const isInternal = internalDomains.map((d) => d.toLowerCase()).includes(lowerDomain);
            if (gmailProvider) {
              const { artifact, section } = await enrichGmailExact(gmailProvider, input.version, guestEmail, ctx);
              googleArtifacts.push(artifact);
              allSections.push(section);
              // Company-domain for non-Consumer non-Internal
              if (domain && !isConsumer && !isInternal) {
                const { artifact: compArtifact, section: compSection } = await enrichGmailCompanyDomain(gmailProvider, input.version, guestEmail, lowerDomain, ctx);
                googleArtifacts.push(compArtifact);
                allSections.push(compSection);
              }
            }
            if (calendarProvider) {
              const { artifact, section } = await enrichCalendarHistory(calendarProvider, input.version, guestEmail, input.startAt, ctx);
              googleArtifacts.push(artifact);
              allSections.push(section);
            }
            if (driveProvider) {
              const companyForDrive = !isConsumer && !isInternal && domain ? lowerDomain : null;
              const { artifact, section } = await enrichDriveDocs(driveProvider, input.version, guestEmail, companyForDrive, ctx);
              googleArtifacts.push(artifact);
              allSections.push(section);
            }
          }

          // Bounded Guest Profile lookup per External Guest (kept for completeness)
          const guestsForProfile = externalAttendees.map((a) => a.email);
          if (deps.profileProvider) {
            for (const email of guestsForProfile) {
              const artifact = await deps.profileProvider.lookup({
                guestEmail: email,
                endpoint: deps.guestProfileEndpoint ?? "",
                apiKey: deps.guestProfileApiKey ?? "",
                occurrenceKey,
                eventVersion: input.version,
              });
              const sanitized = email.replace(/[^a-zA-Z0-9]/g, "_");
              ctx.writeFile(
                `profile-${sanitized}-${input.version}.json`,
                JSON.stringify(artifact, null, 2) + "\n",
              );
              const status =
                artifact.outcome === "completed"
                  ? "completed"
                  : artifact.outcome === "empty"
                    ? "empty"
                    : "failed";
              allSections.push({
                source: GUEST_PROFILE_PROVIDER_ID,
                guest: email,
                status,
                evidence:
                  artifact.outcome === "completed"
                    ? [
                        ...(artifact.role ? [artifact.role] : []),
                        ...(artifact.background ? [artifact.background] : []),
                        ...(artifact.currentEmployer ? [artifact.currentEmployer.name] : []),
                      ]
                    : [],
                references: artifact.references,
                diagnostics: artifact.diagnostics,
                identityConfidence: artifact.identityConfidence,
                role: artifact.role,
                background: artifact.background,
                currentEmployer: artifact.currentEmployer,
                employerMatch: isEmployerMatch(artifact),
              });
              ctx.event("guest_profile_enriched", {
                guest: email,
                outcome: artifact.outcome,
                employerMatch: isEmployerMatch(artifact),
              });
            }
          }

          // If no external guests (should not happen because snapshot would have skipped, but keep graceful)
          // Still produce empty result rather than failing
          enrichResult = {
            sections: allSections,
            evidence: (allSections as { evidence: string[] }[]).flatMap((s) => s.evidence),
          };
          // Also write google artifacts count for diagnostics
          ctx.event("google_enrich_completed", { guests: externalAttendees.length, artifacts: googleArtifacts.length });
        } else {
          // Default fixture enrichment — deterministic evidence per guest/company (legacy for tracer bullet tests).
          const guests = input.attendees.filter((a) => !a.resource).map((a) => a.email);
          const sections: unknown[] = guests.map((email) => ({
            source: "fixture",
            guest: email,
            status: "completed",
            evidence: [`fixture evidence for ${email}`],
            references: [`https://example.com/${email}`],
          }));
          // Bounded Guest Profile lookup per External Guest (fixed contract, no LinkedIn scraping)
          if (deps.profileProvider) {
            for (const email of guests) {
              const artifact = await deps.profileProvider.lookup({
                guestEmail: email,
                endpoint: deps.guestProfileEndpoint ?? "",
                apiKey: deps.guestProfileApiKey ?? "",
                occurrenceKey,
                eventVersion: input.version,
              });
              const sanitized = email.replace(/[^a-zA-Z0-9]/g, "_");
              ctx.writeFile(
                `profile-${sanitized}-${input.version}.json`,
                JSON.stringify(artifact, null, 2) + "\n",
              );
              const status =
                artifact.outcome === "completed"
                  ? "completed"
                  : artifact.outcome === "empty"
                    ? "empty"
                    : "failed";
              sections.push({
                source: GUEST_PROFILE_PROVIDER_ID,
                guest: email,
                status,
                evidence:
                  artifact.outcome === "completed"
                    ? [
                        ...(artifact.role ? [artifact.role] : []),
                        ...(artifact.background ? [artifact.background] : []),
                        ...(artifact.currentEmployer ? [artifact.currentEmployer.name] : []),
                      ]
                    : [],
                references: artifact.references,
                diagnostics: artifact.diagnostics,
                identityConfidence: artifact.identityConfidence,
                role: artifact.role,
                background: artifact.background,
                currentEmployer: artifact.currentEmployer,
                employerMatch: isEmployerMatch(artifact),
              });
              ctx.event("guest_profile_enriched", {
                guest: email,
                outcome: artifact.outcome,
                employerMatch: isEmployerMatch(artifact),
              });
            }
          }
          enrichResult = {
            sections,
            evidence: (sections as { evidence: string[] }[]).flatMap((s) => s.evidence),
          };
        }
        ctx.writeFile(
          "enrich.json",
          JSON.stringify({ ...enrichResult, profileArtifacts }, null, 2) + "\n",
        );
        ctx.event("enrich_completed", {
          sections: enrichResult.sections.length,
          profileArtifacts: profileArtifacts.length,
        });
      });

      // compose — structured Meeting Brief via injected model
      let brief: MeetingBrief;
      await ctx.stage("compose", async () => {
        if (deps.completeBrief) {
          brief = await deps.completeBrief(input, enrichResult);
        } else {
          const genAt = now().toISOString();
          const guestList = input.attendees
            .filter((a) => !a.resource)
            .map((a) => ({
              email: a.email,
              name: a.displayName ?? null,
              role: "Fixture Role",
              background: `Background for ${a.email}`,
              relationshipHistory: [`Prior meeting with ${a.email}`],
              crmContext: `CRM context for ${a.email}`,
              talkingPoints: [`Talk about ${input.summary} with ${a.email}`],
              uncertainty: [],
            }));
          brief = {
            version: 1,
            eventId: input.eventId,
            occurrenceId: input.occurrenceId,
            eventVersion: input.version,
            generatedAt: genAt,
            summary: `Brief for ${input.summary}`,
            guests: guestList,
            companies: [
              {
                name: "Fixture Corp",
                domain: "fixture.example",
                hubspotContext: "HubSpot fixture",
                docs: ["Drive doc fixture"],
                news: ["Recent news fixture"],
                industry: ["Industry fixture"],
                uncertainty: [],
              },
            ],
            conversationStarters: [
              `What brought you to ${input.summary}?`,
              `How does Fixture Corp approach this?`,
            ],
            sourceReferences: enrichResult.evidence,
            missingEvidence: [],
            uncertainty: [],
          };
        }
        // Persist intermediate result (without delivery) — compose's durable output.
        const partial: MeetingBriefRunResult = {
          version: 1,
          eventId: input.eventId,
          occurrenceId: input.occurrenceId,
          eventVersion: input.version,
          occurrenceKey,
          snapshotAt,
          enrichAt: now().toISOString(),
          composeAt: now().toISOString(),
          meetingBrief: brief!,
          delivery: {
            status: "pending",
            sentAt: null,
            messageId: null,
            recipient: null,
            attempts: 0,
          },
          supersedes: null,
        };
        ctx.writeFile("result.json", JSON.stringify(partial, null, 2) + "\n");
        ctx.event("brief_composed", { eventVersion: input.version, guests: brief!.guests.length });
      });
      // deliver — owner-only send via injected delivery
      let delivery: MeetingBriefDeliveryState = {
        status: "pending",
        sentAt: null,
        messageId: null,
        recipient: null,
        attempts: 0,
      };
      await ctx.stage("deliver", async () => {
        let recipient: string;
        let messageId: string | null;
        let sentAt: string | null;
        if (deps.deliver) {
          const sent = await deps.deliver(brief!, input);
          recipient = sent.recipient;
          messageId = sent.messageId;
          sentAt = now().toISOString();
        } else {
          // Fixture delivery — deterministic.
          messageId = `fixture-${occurrenceKey}-${Date.now()}`;
          recipient = "owner@example.com";
          sentAt = now().toISOString();
        }
        delivery = { status: "sent", sentAt, messageId, recipient, attempts: 1 };
        ctx.writeFile("delivery.json", JSON.stringify(delivery, null, 2) + "\n");
        ctx.event("brief_delivered", { messageId, recipient });
        // Update result.json with delivery state.
        const prevRaw = ctx.readFile("result.json");
        if (prevRaw) {
          try {
            const prev = JSON.parse(prevRaw) as MeetingBriefRunResult;
            prev.delivery = delivery;
            ctx.writeFile("result.json", JSON.stringify(prev, null, 2) + "\n");
          } catch {
            // ignore
          }
        }
        if (deps.invalidateIndex) deps.invalidateIndex();
      });

      const displayBrief = brief!;
      return {
        status: "done",
        summary: `Brief for ${input.summary} — ${displayBrief.guests.length} guest(s)`,
        detail: {
          eventId: input.eventId,
          occurrenceKey,
          eventVersion: input.version,
          guests: displayBrief.guests.length,
        },
      };
    },
  };
}
