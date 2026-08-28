/* eslint-disable @typescript-eslint/no-unnecessary-condition */
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
import { snapshotEligibility, buildFrozenSnapshot } from "./snapshot.js";
import type { CalendarProvider } from "./calendar.js";
import { isEligibleMeeting } from "./eligibility.js";
export type MeetingBriefInput = MeetingBriefFixtureEvent & {
  occurrenceKey: string;
  supersedesRunId?: string | null;
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
  getOwnerEmail?: () => string | null;
  ownerEmail?: string | null;
  calendarProvider?: CalendarProvider;
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
      const resolveDomains = (): string[] => {
        if (deps.getInternalDomains) return deps.getInternalDomains();
        return deps.internalDomains ?? [];
      };
      const resolveOwner = (): string | null => {
        if (deps.getOwnerEmail) return deps.getOwnerEmail();
        return deps.ownerEmail ?? null;
      };

      // snapshot — freezes current event, occurrence, version; ends skipped when not Eligible.
      // Retained frozen version via snapshot.json (ADR-0033).
      let snapshotSkipped = false;
      let snapshotSkipReason: string | null = null;
      await ctx.stage("snapshot", async () => {
        // Try to freeze current event from provider when available (header-only wake-ups never mistaken for data).
        // Fallback to input which already holds latest reconciled version.
        let current: MeetingBriefFixtureEvent = input;
        if (deps.calendarProvider) {
          try {
            const result = await deps.calendarProvider.listEvents({
              calendarId: input.calendarId,
              syncToken: null,
            });
            const found = result.events.find(
              (e) => `${e.eventId}::${e.occurrenceId}` === occurrenceKey,
            );
            if (found) {
              current = {
                calendarId: found.calendarId,
                eventId: found.eventId,
                occurrenceId: found.occurrenceId,
                version: found.version,
                summary: found.summary,
                description: found.description,
                startAt: found.startAt,
                endAt: found.endAt,
                location: found.location ?? null,
                conferenceLink: found.conferenceLink ?? null,
                organizer: found.organizer,
                attendees: found.attendees,
                attachments: found.attachments,
                colorId: found.colorId,
                etag: found.etag,
                visibility: found.visibility,
                transparency: found.transparency,
                created: found.created,
                updated: found.updated,
              } as MeetingBriefFixtureEvent;
            }
            // else: not found — fallback to input (fixture direct-schedule); eligibility below handles real deletion
          } catch {
            // Provider unavailable — fallback to input
          }
        }
        const domains = resolveDomains();
        const owner = resolveOwner();
        const { eligible, reason } = snapshotEligibility(current, domains, owner);
        if (!eligible) {
          ctx.event("snapshot_skipped", {
            eventId: current.eventId,
            occurrenceId: current.occurrenceId,
            occurrenceKey,
            version: current.version,
            reason,
          });
          const frozen = buildFrozenSnapshot(current, occurrenceKey, snapshotAt);
          ctx.writeFile(
            "snapshot.json",
            JSON.stringify({ ...frozen, eligible: false, skipReason: reason }, null, 2) + "\n",
          );
          snapshotSkipped = true;
          snapshotSkipReason = reason;
          return;
        }
        // Eligible: freeze snapshot
        ctx.event("snapshot_captured", {
          eventId: current.eventId,
          occurrenceId: current.occurrenceId,
          occurrenceKey,
          version: current.version,
          startAt: current.startAt,
        });
        const frozen = buildFrozenSnapshot(current, occurrenceKey, snapshotAt);
        ctx.writeFile(
          "snapshot.json",
          JSON.stringify({ ...frozen, eligible: true, capturedAt: snapshotAt }, null, 2) + "\n",
        );
        // Preserve frozen version retained — ensure later stages use current's version if provider fetch diverged
        // Update input version fields to frozen version for enrich/compose/deliver consistency
        if (current.version !== input.version) {
          input.version = current.version;
          input.summary = current.summary;
          if (current.description !== undefined) {
            (input as unknown as Record<string, unknown>).description = current.description;
          } else {
            delete (input as unknown as Record<string, unknown>).description;
          }
          input.startAt = current.startAt;
          input.endAt = current.endAt;
          input.location = current.location ?? null;
          input.conferenceLink = current.conferenceLink ?? null;
          if (current.organizer !== undefined) {
            (input as unknown as Record<string, unknown>).organizer = current.organizer;
          } else {
            delete (input as unknown as Record<string, unknown>).organizer;
          }
          input.attendees = current.attendees;
          if (current.attachments !== undefined) {
            (input as unknown as Record<string, unknown>).attachments = current.attachments;
          } else {
            delete (input as unknown as Record<string, unknown>).attachments;
          }
        }
      });

      if (snapshotSkipped) {
        // No enrichment/email after skipped (issue://84).
        // Snapshot stage succeeded but Run ends skipped; remaining stages never run.
        return { status: "skipped", reason: snapshotSkipReason };
      }

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
        const supersedes = (input).supersedesRunId ?? null;
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
          supersedes,
        };
        ctx.writeFile("result.json", JSON.stringify(partial, null, 2) + "\n");
        ctx.event("brief_composed", {
          eventVersion: input.version,
          guests: brief!.guests.length,
          supersedes,
        });
      });
      // deliver — owner-only send via injected delivery; rechecks Calendar before outward delivery
      let delivery: MeetingBriefDeliveryState = {
        status: "pending",
        sentAt: null,
        messageId: null,
        recipient: null,
        attempts: 0,
      };
      let deliverSkipped = false;
      let deliverSkipReason: string | null = null;
      await ctx.stage("deliver", async () => {
        // Cancellation recheck before outward write (ADR-0033): active Run ends skipped when cancelled.
        if (deps.calendarProvider) {
          try {
            const result = await deps.calendarProvider.listEvents({
              calendarId: input.calendarId,
              syncToken: null,
            });
            const current = result.events.find(
              (e) => `${e.eventId}::${e.occurrenceId}` === occurrenceKey,
            );
            const domains = resolveDomains();
            const owner = resolveOwner();
            const stillEligible = current ? isEligibleMeeting(current, domains, owner) : false;
            const isNotFound = !current;
            const hasEvents = result.events.length > 0;
            const isCancelled =
              current?.status === "cancelled" ||
              (current !== undefined && !stillEligible) ||
              (isNotFound && hasEvents);
            if (isCancelled) {
              const reason =
                isNotFound && hasEvents
                  ? "occurrence_not_found"
                  : current?.status === "cancelled"
                    ? "cancelled"
                    : "not_eligible_at_delivery";
              // Persist delivery skipped state for audit while preserving composed brief
              const skippedDelivery: MeetingBriefDeliveryState = {
                status: "pending",
                sentAt: null,
                messageId: null,
                recipient: null,
                attempts: 0,
              };
              ctx.writeFile(
                "delivery.json",
                JSON.stringify({ ...skippedDelivery, skippedReason: reason }, null, 2) + "\n",
              );
              const prevRaw = ctx.readFile("result.json");
              if (prevRaw) {
                try {
                  const prev = JSON.parse(prevRaw) as MeetingBriefRunResult;
                  (prev as unknown as Record<string, unknown>).deliverySkippedReason = reason;
                  ctx.writeFile("result.json", JSON.stringify(prev, null, 2) + "\n");
                } catch {
                  // ignore
                }
              }
              deliverSkipped = true;
              deliverSkipReason = reason;
              return;
            }
          } catch {
            // Provider failure — proceed to deliver (fail open) rather than false cancellation
          }
        }
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

      if (deliverSkipped) {
        return { status: "skipped", reason: deliverSkipReason ?? "cancelled_before_delivery" };
      }

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
