/* eslint-disable @typescript-eslint/no-unnecessary-condition -- module orchestrates optional stage deps and snapshot fields that may be absent on retry */
import type { CompleteJson } from "../../llm/providers.js";
import type {
  GuestProfileArtifact,
  MeetingBrief,
  MeetingBriefDeliveryState,
  MeetingBriefFixtureEvent,
  MeetingBriefEnrichmentSection,
  MeetingBriefRunResult,
} from "@chief-of-staff-demo/shared";
import { MEETING_BRIEF_MODULE_ID, MEETING_BRIEF_MODULE_VERSION } from "@chief-of-staff-demo/shared";
import type { RunOutcome } from "../../runs.js";
import type { RunContext, ShellModule } from "../../engine/module.js";
import type { GuestProfileProvider } from "./profile/provider.js";
import type { GmailProvider } from "./google/gmail.js";
import type { CalendarHistoryProvider } from "./google/calendarHistory.js";
import type { DriveProvider } from "./google/drive.js";
import type { HubSpotApi } from "./hubspot/client.js";
import type { PublicIntelligenceProvider } from "./enrichment/publicIntelligence.js";
import { snapshotEligibility, buildFrozenSnapshot } from "./snapshot.js";
import type { CalendarProvider } from "./calendar.js";
import { isExternalGuest } from "./eligibility.js";
import { composeBrief } from "./compose.js";
import type { GmailDeliveryProvider } from "./google/gmailDelivery.js";
import { executeDeliver, deliveryIdFor } from "./deliver.js";
import { enrichUnified } from "./enrichment/enrich.js";
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
  getCompleteJson?: () => CompleteJson;
  deliver?: (
    brief: MeetingBrief,
    event: MeetingBriefFixtureEvent,
  ) => Promise<{
    messageId: string;
    recipient: string;
  }>;
  gmailDeliveryProvider?: GmailDeliveryProvider | null;
  getGmailDeliveryProvider?: () => GmailDeliveryProvider | null;
  invalidateIndex?: () => void;
  profileProvider?: GuestProfileProvider | null;
  guestProfileEndpoint?: string;
  guestProfileApiKey?: string;
  gmailProvider?: GmailProvider | null;
  calendarHistoryProvider?: CalendarHistoryProvider | null;
  driveProvider?: DriveProvider | null;
  hubSpotApi?: HubSpotApi | null;
  publicIntelligenceProvider?: PublicIntelligenceProvider | null;
  proposeEmployer?: (
    guestEmail: string,
    guestName: string | null,
    eventVersion: string,
  ) => Promise<{ name: string; domain: string | null } | null>;
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

    planResume(meta) {
      if (meta.status === "blocked" && meta.wait?.reason === "quiet_period") {
        return {
          fromStage: "deliver",
          reason: "quiet_period_expired",
          input: {
            calendarId: "resume",
            eventId: meta.externalId?.split("::")[0] ?? "resume",
            occurrenceId: meta.externalId?.split("::")[1] ?? "resume",
            occurrenceKey: meta.externalId ?? "resume",
            version: "resume",
            summary: "resume",
            startAt: now().toISOString(),
            endAt: now().toISOString(),
            attendees: [],
          } as unknown as MeetingBriefInput,
        };
      }
      return null;
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
      const gmailDeliveryProvider =
        deps.getGmailDeliveryProvider?.() ?? deps.gmailDeliveryProvider ?? null;

      // Retry optimization: if result.json already holds a brief and delivery is pending/failed,
      // we are retrying deliver. Snapshot/enrich/compose are preserved; skip them.
      let shouldSkipToDeliver = false;
      let existingBrief: MeetingBrief | null = null;
      const existingResultRaw = ctx.readFile("result.json");
      if (existingResultRaw) {
        try {
          const parsed = JSON.parse(existingResultRaw) as MeetingBriefRunResult;
          const hasBrief = parsed.meetingBrief && typeof parsed.meetingBrief === "object";
          const deliveryStatus = (parsed.delivery as MeetingBriefDeliveryState | null)?.status;
          if (hasBrief && (deliveryStatus === "failed" || deliveryStatus === "pending")) {
            existingBrief = parsed.meetingBrief;
            shouldSkipToDeliver = true;
          } else if (hasBrief && deliveryStatus === "reconciled") {
            // Already reconciled but retry requested? treat as skip to deliver to reconcile again
            existingBrief = parsed.meetingBrief;
            shouldSkipToDeliver = true;
          } else if (hasBrief && !deliveryStatus) {
            existingBrief = parsed.meetingBrief;
            shouldSkipToDeliver = true;
          }
        } catch {
          // ignore parse failure
        }
      }
      // Also check delivery.json failed status even if result parse failed
      if (!shouldSkipToDeliver) {
        const deliveryRaw = ctx.readFile("delivery.json");
        if (deliveryRaw) {
          try {
            const d = JSON.parse(deliveryRaw) as MeetingBriefDeliveryState;
            if (d.status === "failed" && existingBrief) shouldSkipToDeliver = true;
          } catch {
            // ignore
          }
        }
      }
      // If snapshot.json missing but we think we should skip, don't skip — need snapshot
      if (shouldSkipToDeliver && !ctx.readFile("snapshot.json")) {
        shouldSkipToDeliver = false;
        existingBrief = null;
      }
      if (shouldSkipToDeliver && !ctx.readFile("result.json")) {
        shouldSkipToDeliver = false;
        existingBrief = null;
      }

      // snapshot — freezes current event, occurrence, version; ends skipped when not Eligible.
      // Retained frozen version via snapshot.json (ADR-0033).
      let snapshotSkipped = false;
      let snapshotSkipReason: string | null = null;
      if (!shouldSkipToDeliver) {
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
      } else {
        // When skipping to deliver, ensure snapshot input version aligns with frozen snapshot
        const snapRaw = ctx.readFile("snapshot.json");
        if (snapRaw) {
          try {
            const snap = JSON.parse(snapRaw) as { version?: string; summary?: string };
            if (typeof snap.version === "string" && snap.version.length > 0) {
              input.version = snap.version;
              if (typeof snap.summary === "string") input.summary = snap.summary;
            }
          } catch {
            // ignore
          }
        }
      }

      // enrich — unified evidence via Google, HubSpot, Guest Profile, Public Intelligence (issue://88)
      let enrichResult: { sections: unknown[]; evidence: string[] } = {
        sections: [],
        evidence: [],
      };
      const profileArtifacts: GuestProfileArtifact[] = [];
      if (!shouldSkipToDeliver) {
        await ctx.stage("enrich", async () => {
          if (deps.enrich) {
            enrichResult = await deps.enrich(input, ctx);
          } else if (
            deps.gmailProvider ||
            deps.calendarHistoryProvider ||
            deps.driveProvider ||
            deps.profileProvider ||
            deps.hubSpotApi ||
            deps.publicIntelligenceProvider
          ) {
            // Resolve frozen version for retry preservation (snapshot.json holds original version if retry input is stub)
            const snapshotRawForVersion = ctx.readFile("snapshot.json");
            let frozenVersion = input.version;
            if (snapshotRawForVersion) {
              try {
                const snap = JSON.parse(snapshotRawForVersion) as { version?: string };
                if (typeof snap.version === "string" && snap.version.length > 0) {
                  frozenVersion = snap.version;
                }
              } catch {
                // ignore
              }
            }
            const useInput: MeetingBriefInput =
              frozenVersion !== input.version ? { ...input, version: frozenVersion } : input;
            const internalDomainsForEnrich = deps.getInternalDomains
              ? deps.getInternalDomains()
              : (deps.internalDomains ?? []);
            const result = await enrichUnified(useInput, ctx, {
              gmailProvider: deps.gmailProvider ?? null,
              calendarHistoryProvider: deps.calendarHistoryProvider ?? null,
              driveProvider: deps.driveProvider ?? null,
              profileProvider: deps.profileProvider ?? null,
              hubSpotApi: deps.hubSpotApi ?? null,
              publicIntelligenceProvider: deps.publicIntelligenceProvider ?? null,
              ...(deps.proposeEmployer ? { proposeEmployer: deps.proposeEmployer } : {}),
              internalDomains: internalDomainsForEnrich,
              now,
              ...(deps.guestProfileEndpoint
                ? { guestProfileEndpoint: deps.guestProfileEndpoint }
                : {}),
              ...(deps.guestProfileApiKey ? { guestProfileApiKey: deps.guestProfileApiKey } : {}),
              occurrenceKey,
            });
            enrichResult = result;
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
      } else {
        // Skipped enrich — load existing enrich.json if needed for compose fallback (but compose is also skipped)
        const enrichRaw = ctx.readFile("enrich.json");
        if (enrichRaw) {
          try {
            const parsed = JSON.parse(enrichRaw) as { sections?: unknown[]; evidence?: string[] };
            enrichResult = {
              sections: (parsed.sections as unknown[]) ?? [],
              evidence: (parsed.evidence as string[]) ?? [],
            };
          } catch {
            // ignore
          }
        }
      }

      // compose — structured Meeting Brief via LLM seam (Result Shape Binding, ADR-0029/0030)
      let brief: MeetingBrief;
      if (existingBrief) {
        brief = existingBrief;
      } else {
        // This will be assigned inside compose stage
        brief = null as unknown as MeetingBrief;
      }
      if (!shouldSkipToDeliver) {
        await ctx.stage("compose", async () => {
          if (deps.completeBrief) {
            brief = await deps.completeBrief(input, enrichResult);
          } else if (deps.getCompleteJson) {
            const sections = (enrichResult.sections as MeetingBriefEnrichmentSection[]) ?? [];
            const snapshotForCompose = {
              ...input,
              occurrenceKey,
            } as unknown as MeetingBriefFixtureEvent & { occurrenceKey: string };
            const snapshotRaw = ctx.readFile("snapshot.json");
            if (snapshotRaw) {
              try {
                const snap = JSON.parse(snapshotRaw) as MeetingBriefFixtureEvent & {
                  occurrenceKey?: string;
                  version?: string;
                };
                if (typeof snap.version === "string" && snap.version.length > 0) {
                  (snapshotForCompose as unknown as Record<string, unknown>).version = snap.version;
                }
                if (typeof snap.summary === "string") snapshotForCompose.summary = snap.summary;
                if (typeof snap.startAt === "string")
                  (snapshotForCompose as unknown as Record<string, unknown>).startAt = snap.startAt;
                if (typeof snap.endAt === "string")
                  (snapshotForCompose as unknown as Record<string, unknown>).endAt = snap.endAt;
                if ("location" in snap)
                  (snapshotForCompose as unknown as Record<string, unknown>).location = (
                    snap as unknown as Record<string, unknown>
                  ).location;
                if ("conferenceLink" in snap)
                  (snapshotForCompose as unknown as Record<string, unknown>).conferenceLink = (
                    snap as unknown as Record<string, unknown>
                  ).conferenceLink;
                if ("organizer" in snap)
                  (snapshotForCompose as unknown as Record<string, unknown>).organizer = (
                    snap as unknown as Record<string, unknown>
                  ).organizer;
                if (Array.isArray((snap as unknown as Record<string, unknown>).attendees)) {
                  (snapshotForCompose as unknown as Record<string, unknown>).attendees = (
                    snap as unknown as Record<string, unknown>
                  ).attendees;
                }
              } catch {
                // ignore
              }
            }
            const internalDomainsForCompose = deps.getInternalDomains
              ? deps.getInternalDomains()
              : (deps.internalDomains ?? []);
            brief = await composeBrief({
              now,
              getCompleteJson: deps.getCompleteJson,
              snapshot: snapshotForCompose,
              sections,
              internalDomains: internalDomainsForCompose,
            });
          } else {
            const genAt = now().toISOString();
            const internalDomainsForFixture = deps.getInternalDomains
              ? deps.getInternalDomains()
              : (deps.internalDomains ?? []);
            const externalForFixture = input.attendees.filter(
              (a) => !a.resource && isExternalGuest(a, internalDomainsForFixture),
            );
            const guestList = externalForFixture.map((a) => ({
              email: a.email,
              name: a.displayName ?? null,
              role: "Fixture Role",
              background: `Background for ${a.email}`,
              relationshipHistory: [`Prior meeting with ${a.email}`],
              crmContext: `CRM context for ${a.email}`,
              talkingPoints: [`Talk about ${input.summary} with ${a.email}`],
              uncertainty: [] as string[],
              evidenceReferences:
                (enrichResult as unknown as { evidence: string[] }).evidence?.slice(0, 3) ?? [],
            }));
            const sectionsForFixture =
              (enrichResult.sections as unknown as MeetingBriefEnrichmentSection[]) ?? [];
            const hasEmployerMatch = sectionsForFixture.some(
              (s) => s.source === "employer-match" && s.status === "completed",
            );
            brief = {
              version: 1,
              eventId: input.eventId,
              occurrenceId: input.occurrenceId,
              eventVersion: input.version,
              generatedAt: genAt,
              logistics: {
                title: input.summary,
                startAt: input.startAt,
                endAt: input.endAt,
                location: input.location ?? null,
                conferenceLink: input.conferenceLink ?? null,
                organizer: input.organizer
                  ? input.organizer.displayName !== undefined
                    ? { email: input.organizer.email, displayName: input.organizer.displayName }
                    : { email: input.organizer.email }
                  : null,
              },
              summary: `Brief for ${input.summary}`,
              guests: guestList,
              companies: hasEmployerMatch
                ? [
                    {
                      name: "Fixture Corp",
                      domain: "fixture.example",
                      hubspotContext: "HubSpot fixture",
                      docs: ["Drive doc fixture"],
                      news: ["Recent news fixture"],
                      industry: ["Industry fixture"],
                      uncertainty: [],
                      evidenceReferences: [],
                    },
                  ]
                : [],
              conversationStarters: [
                `What brought you to ${input.summary}?`,
                `How does Fixture Corp approach this?`,
              ],
              sourceReferences: (enrichResult as unknown as { evidence: string[] }).evidence ?? [],
              missingEvidence: [],
              uncertainty: [],
            };
          }
          const supersedes = input.supersedesRunId ?? null;
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
              deliveryId: deliveryIdFor(occurrenceKey, brief!.eventVersion),
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
      } else {
        // Verify brief was loaded; if not, try to load from result.json again
        if (!brief) {
          const raw = ctx.readFile("result.json");
          if (raw) {
            try {
              const prev = JSON.parse(raw) as MeetingBriefRunResult;
              brief = prev.meetingBrief;
            } catch {
              // fallback: will be caught below
            }
          }
        }
        if (!brief) {
          throw new Error("Retry from deliver requires existing MeetingBrief in result.json");
        }
      }
      // deliver — owner-only send with rechecks, idempotency, reconciliation (ADR-0034)
      const deliverOutcome = await ctx.stage("deliver", async () => {
        const deliverArgs: Parameters<typeof executeDeliver>[0] = {
          ctx,
          brief: brief!,
          input,
          occurrenceKey,
          now,
          calendarProvider: deps.calendarProvider ?? null,
          gmailDeliveryProvider: gmailDeliveryProvider ?? null,
          getInternalDomains: () => resolveDomains(),
          getOwnerEmail: () => resolveOwner(),
        };
        if (deps.deliver) deliverArgs.fallbackDeliver = deps.deliver;
        if (deps.invalidateIndex) deliverArgs.invalidateIndex = deps.invalidateIndex;
        return executeDeliver(deliverArgs);
      });

      if (deliverOutcome.skipped) {
        return {
          status: "skipped",
          reason: deliverOutcome.skipReason ?? "cancelled_before_delivery",
        };
      }
      // Superseded is not a skip of the Run; it's a successful completion with delivery superseded.
      // The Run remains done, but index will show superseded delivery.

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
