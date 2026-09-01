/* eslint-disable @typescript-eslint/no-unnecessary-condition -- module orchestrates optional stage deps and snapshot fields that may be absent on retry */
import type { CompleteJson } from "../../llm/providers.js";
import type {
  MeetingBrief,
  MeetingBriefEvent,
  MeetingBriefEnrichmentSection,
  MeetingBriefPersonProfileLink,
  MeetingBriefRunResult,
  PersonProfileConsumerState,
} from "@chief-of-staff-demo/shared";
import { MEETING_BRIEF_MODULE_ID, MEETING_BRIEF_MODULE_VERSION } from "@chief-of-staff-demo/shared";
import {
  meetingBriefOccurrenceIdentity,
  parseMeetingBriefOccurrenceKey,
} from "@chief-of-staff-demo/shared";
import type { RunOutcome } from "../../runs.js";
import type { RunContext, ShellModule } from "../../engine/module.js";
import { snapshotEligibility, buildFrozenSnapshot } from "./snapshot.js";
import { occurrenceLookupWindow, type CalendarProvider } from "./calendar.js";
import { composeBrief } from "./compose.js";
import type { GmailDeliveryProvider } from "./google/gmailDelivery.js";
import { executeDeliver, deliveryIdFor, deliveryState } from "./deliver.js";
import { enrichUnified, type MeetingBriefEnrichmentProviders } from "./enrichment/enrich.js";
export type MeetingBriefInput = MeetingBriefEvent & {
  occurrenceKey: string;
  supersedesRunId?: string | null;
  profileRefreshOf?: string;
};
export interface MeetingBriefModuleDeps {
  now?: () => Date;
  enrich?: (
    input: MeetingBriefInput,
    ctx: RunContext,
  ) => Promise<{
    sections: unknown[];
    evidence: string[];
    personProfileLinks?: MeetingBriefPersonProfileLink[];
  }>;
  completeBrief?: (input: MeetingBriefInput, enrichResult: unknown) => Promise<MeetingBrief>;
  getCompleteJson?: () => CompleteJson;
  gmailDeliveryProvider?: GmailDeliveryProvider | null;
  enrichmentProviders?: MeetingBriefEnrichmentProviders;
  getInternalDomains?: () => string[];
  getOwnerEmail?: () => string | null;
  calendarProvider?: CalendarProvider;
  calendarSnapshotRequired?: boolean;
  personProfileConsumerState?: (
    profileId: string,
    profileRevision: number,
  ) => PersonProfileConsumerState | null;
}

function continuationInput(externalId: string | null, now: Date): MeetingBriefInput {
  const occurrenceKey = externalId ?? "unknown::unknown";
  const identity = parseMeetingBriefOccurrenceKey(occurrenceKey);
  const eventId = identity?.eventId ?? "unknown";
  const occurrenceId = identity?.occurrenceId ?? "unknown";
  return {
    calendarId: "primary",
    eventId,
    occurrenceId,
    occurrenceKey,
    version: "continuation",
    summary: "Meeting Brief continuation",
    startAt: now.toISOString(),
    endAt: now.toISOString(),
    attendees: [],
    status: "confirmed",
  };
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
      return {
        fromStage,
        reason: "failed_stage_is_safe_to_repeat",
        input: continuationInput(meta.externalId, now()),
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
          input: continuationInput(state.externalId, now()),
        };
      if (!files.has("enrich.json"))
        return {
          fromStage: "enrich",
          reason: "durable_progress_first_incomplete",
          input: continuationInput(state.externalId, now()),
        };
      if (!files.has("result.json"))
        return {
          fromStage: "compose",
          reason: "durable_progress_first_incomplete",
          input: continuationInput(state.externalId, now()),
        };
      return {
        fromStage: "deliver",
        reason: "durable_progress_first_incomplete",
        input: continuationInput(state.externalId, now()),
      };
    },

    planResume(meta) {
      if (meta.status === "blocked" && meta.wait?.reason === "quiet_period") {
        return {
          fromStage: "deliver",
          reason: "quiet_period_expired",
          input: continuationInput(meta.externalId, now()),
        };
      }
      return null;
    },

    async run(ctx: RunContext, input: MeetingBriefInput): Promise<RunOutcome> {
      const frozenSnapshotRaw = ctx.readFile("snapshot.json");
      let hasFrozenSnapshot = false;
      if (frozenSnapshotRaw) {
        try {
          const frozen = JSON.parse(frozenSnapshotRaw) as MeetingBriefInput;
          if (
            typeof frozen.calendarId === "string" &&
            typeof frozen.eventId === "string" &&
            typeof frozen.occurrenceId === "string" &&
            typeof frozen.occurrenceKey === "string" &&
            typeof frozen.version === "string" &&
            ["confirmed", "cancelled", "tentative"].includes(frozen.status) &&
            Array.isArray(frozen.attendees)
          ) {
            input = frozen;
            hasFrozenSnapshot = true;
          }
        } catch {
          // A corrupt snapshot cannot be trusted as retry input; snapshot will run again and fail visibly if needed.
        }
      }
      const occurrenceKey = input.occurrenceKey;
      const snapshotAt = now().toISOString();
      const resolveDomains = (): string[] => {
        if (deps.getInternalDomains) return deps.getInternalDomains();
        return [];
      };
      const resolveOwner = (): string | null => {
        if (deps.getOwnerEmail) return deps.getOwnerEmail();
        return null;
      };
      const gmailDeliveryProvider = deps.gmailDeliveryProvider ?? null;

      // Retry optimization: if result.json already holds a brief and delivery is pending/failed,
      // we are retrying deliver. Snapshot/enrich/compose are preserved; skip them.
      let shouldSkipToDeliver = false;
      let existingBrief: MeetingBrief | null = null;
      const existingResultRaw = ctx.readFile("result.json");
      if (existingResultRaw) {
        try {
          const parsed = JSON.parse(existingResultRaw) as MeetingBriefRunResult;
          const hasBrief = parsed.meetingBrief && typeof parsed.meetingBrief === "object";
          const deliveryStatus = parsed.delivery?.status;
          if (hasBrief && (deliveryStatus === "failed" || deliveryStatus === "pending")) {
            existingBrief = parsed.meetingBrief;
            shouldSkipToDeliver = true;
          }
        } catch {
          // ignore parse failure
        }
      }
      // If snapshot.json missing but we think we should skip, don't skip — need snapshot
      if (shouldSkipToDeliver && !ctx.readFile("snapshot.json")) {
        shouldSkipToDeliver = false;
        existingBrief = null;
      }
      // snapshot — freezes current event, occurrence, version; ends skipped when not Eligible.
      // Retained frozen version via snapshot.json (ADR-0033).
      let snapshotSkipped = false;
      let snapshotSkipReason: string | null = null;
      if (!shouldSkipToDeliver && !hasFrozenSnapshot) {
        await ctx.stage("snapshot", async () => {
          // Freeze current Calendar truth when a provider is available. Provider failures fail
          // snapshot; a missing occurrence is an explicit skip, never stale Intake fallback.
          let current: MeetingBriefEvent = input;
          if (deps.calendarProvider) {
            let result: Awaited<ReturnType<CalendarProvider["listEvents"]>> | null = null;
            try {
              result = await deps.calendarProvider.listEvents({
                calendarId: input.calendarId,
                syncToken: null,
                ...occurrenceLookupWindow(now(), input.startAt),
              });
            } catch (error) {
              if (deps.calendarSnapshotRequired) throw error;
            }
            // A host with calendarUse "recheck" injects Calendar for delivery only, so a
            // failed list lands here best-effort. Production uses "snapshot", which sets
            // calendarSnapshotRequired above, so a failed list cannot reach this branch.
            if (result) {
              const found = result.events.find(
                (event) =>
                  meetingBriefOccurrenceIdentity(event.eventId, event.occurrenceId)
                    .occurrenceKey === occurrenceKey,
              );
              if (!found && deps.calendarSnapshotRequired) {
                const frozen = buildFrozenSnapshot(input, snapshotAt);
                ctx.writeFile(
                  "snapshot.json",
                  JSON.stringify(
                    { ...frozen, eligible: false, skipReason: "occurrence_not_found" },
                    null,
                    2,
                  ) + "\n",
                );
                ctx.event("snapshot_skipped", {
                  eventId: input.eventId,
                  occurrenceId: input.occurrenceId,
                  occurrenceKey,
                  version: input.version,
                  reason: "occurrence_not_found",
                });
                snapshotSkipped = true;
                snapshotSkipReason = "occurrence_not_found";
                return;
              }
              if (found) current = found;
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
            const frozen = buildFrozenSnapshot(current, snapshotAt);
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
          const frozen = buildFrozenSnapshot(current, snapshotAt);
          ctx.writeFile(
            "snapshot.json",
            JSON.stringify(
              {
                ...frozen,
                eligible: true,
                capturedAt: snapshotAt,
                supersedesRunId: input.supersedesRunId ?? null,
                ...(input.profileRefreshOf ? { profileRefreshOf: input.profileRefreshOf } : {}),
              },
              null,
              2,
            ) + "\n",
          );
          input = {
            ...current,
            occurrenceKey,
            supersedesRunId: input.supersedesRunId ?? null,
            ...(input.profileRefreshOf ? { profileRefreshOf: input.profileRefreshOf } : {}),
          };
        });

        if (snapshotSkipped) {
          // No enrichment/email after skipped (issue://84).
          // Snapshot stage succeeded but Run ends skipped; remaining stages never run.
          return { status: "skipped", reason: snapshotSkipReason };
        }
      }

      // enrich — unified evidence via Google, HubSpot, Person Profiles, Public Intelligence
      let enrichResult: {
        sections: unknown[];
        evidence: string[];
        personProfileLinks?: MeetingBriefPersonProfileLink[];
      } = {
        sections: [],
        evidence: [],
      };
      const hasFrozenEnrichment = ctx.readFile("enrich.json") !== null;
      if (!shouldSkipToDeliver && !hasFrozenEnrichment) {
        await ctx.stage("enrich", async () => {
          if (deps.enrich) {
            enrichResult = await deps.enrich(input, ctx);
          } else if (deps.enrichmentProviders) {
            const internalDomainsForEnrich = deps.getInternalDomains?.() ?? [];
            const result = await enrichUnified(input, ctx, {
              providers: deps.enrichmentProviders,
              internalDomains: internalDomainsForEnrich,
              occurrenceKey,
            });
            enrichResult = result;
          } else {
            throw new Error("Meeting Brief enrichment providers are unavailable");
          }
          ctx.writeFile("enrich.json", JSON.stringify(enrichResult, null, 2) + "\n");
          ctx.event("enrich_completed", {
            sections: enrichResult.sections.length,
          });
        });
      } else if (!shouldSkipToDeliver) {
        // Compose retry reuses the completed enrichment artifact.
        const enrichRaw = ctx.readFile("enrich.json");
        if (enrichRaw) {
          try {
            const parsed = JSON.parse(enrichRaw) as {
              sections?: unknown[];
              evidence?: string[];
              personProfileLinks?: MeetingBriefPersonProfileLink[];
            };
            enrichResult = {
              sections: (parsed.sections as unknown[]) ?? [],
              evidence: (parsed.evidence as string[]) ?? [],
              personProfileLinks: parsed.personProfileLinks ?? [],
            };
          } catch {
            // ignore
          }
        }
      }

      // compose — structured Meeting Brief via LLM seam (Result Shape Binding, ADR-0029/0030)
      let brief: MeetingBrief | null = existingBrief;
      if (!shouldSkipToDeliver) {
        await ctx.stage("compose", async () => {
          let composed: MeetingBrief;
          if (deps.completeBrief) {
            composed = await deps.completeBrief(input, enrichResult);
          } else if (deps.getCompleteJson) {
            const sections = (enrichResult.sections as MeetingBriefEnrichmentSection[]) ?? [];
            const internalDomainsForCompose = deps.getInternalDomains?.() ?? [];
            composed = await composeBrief({
              now,
              getCompleteJson: deps.getCompleteJson,
              snapshot: input,
              sections,
              internalDomains: internalDomainsForCompose,
            });
          } else {
            throw new Error("Meeting Brief composition provider is unavailable");
          }
          brief = composed;
          const supersedes = input.supersedesRunId ?? null;
          const deliveryVersion = input.profileRefreshOf
            ? `${composed.eventVersion}-profile-${ctx.runId}`
            : composed.eventVersion;
          const partial: MeetingBriefRunResult = {
            version: 1,
            eventId: input.eventId,
            occurrenceId: input.occurrenceId,
            eventVersion: input.version,
            occurrenceKey,
            snapshotAt,
            enrichAt: now().toISOString(),
            composeAt: now().toISOString(),
            meetingBrief: composed,
            delivery: deliveryState("pending", deliveryIdFor(occurrenceKey, deliveryVersion)),
            personProfileLinks: enrichResult.personProfileLinks ?? [],
            supersedes,
            ...(input.profileRefreshOf ? { profileRefreshOf: input.profileRefreshOf } : {}),
          };
          ctx.writeFile("result.json", JSON.stringify(partial, null, 2) + "\n");
          ctx.event("brief_composed", {
            eventVersion: input.version,
            guests: composed.guests.length,
            supersedes,
          });
        });
      }
      if (!brief) throw new Error("Deliver requires a composed Meeting Brief");
      const composedBrief = brief;
      // deliver — owner-only send with rechecks, idempotency, reconciliation (ADR-0034)
      const deliverOutcome = await ctx.stage("deliver", async () => {
        const deliverArgs: Parameters<typeof executeDeliver>[0] = {
          ctx,
          brief: composedBrief,
          input,
          occurrenceKey,
          now,
          calendarProvider: deps.calendarProvider ?? null,
          gmailDeliveryProvider: gmailDeliveryProvider ?? null,
          getInternalDomains: () => resolveDomains(),
          getOwnerEmail: () => resolveOwner(),
          ...(deps.personProfileConsumerState
            ? { personProfileConsumerState: deps.personProfileConsumerState }
            : {}),
        };
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

      return {
        status: "done",
        summary: `Brief for ${input.summary} — ${composedBrief.guests.length} guest(s)`,
        detail: {
          eventId: input.eventId,
          occurrenceKey,
          eventVersion: input.version,
          guests: composedBrief.guests.length,
        },
      };
    },
  };
}
