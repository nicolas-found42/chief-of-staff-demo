import type { FastifyInstance } from "fastify";
import type { MeetingBrief, MeetingBriefEvent } from "@chief-of-staff-demo/shared";
import type { ConfigStore } from "../../config.js";
import type { Runs } from "../../runs.js";
import { FakeCalendarProvider, type CalendarEvent } from "./calendar.js";
import { FakeGmailDeliveryProvider, type GmailDeliveryProvider } from "./google/gmailDelivery.js";
import { MeetingBriefHost } from "./host.js";
import { HubSpotConnection } from "./hubspot/connection.js";
import type { WorkspacePersonProfiles } from "../../person-profile/profiles.js";

export interface MeetingBriefTestRuntimeOptions {
  runs: Runs;
  workspaceDir: string;
  configStore: ConfigStore;
  initialNow: Date;
  personProfiles?: WorkspacePersonProfiles;
}

export function fixtureGmailDeliveryProvider(
  messageId = "fixture-message",
  recipient = "owner@example.com",
): GmailDeliveryProvider {
  return {
    async findByDeliveryId() {
      return null;
    },
    async send() {
      return { messageId, recipient };
    },
  };
}

/** Typed deterministic composer for host-seam tests that exercise real enrichment adapters. */
export async function completeFixtureBrief(
  input: MeetingBriefEvent,
  enrichment: unknown,
): Promise<MeetingBrief> {
  const sections =
    (enrichment as { sections?: Array<{ source?: string; company?: string }> }).sections ?? [];
  const companyNames = sections
    .filter((section) => section.source === "employer-match" && section.company)
    .map((section) => section.company!);
  return {
    version: 1,
    eventId: input.eventId,
    occurrenceId: input.occurrenceId,
    eventVersion: input.version,
    generatedAt: input.startAt,
    logistics: {
      title: input.summary,
      startAt: input.startAt,
      endAt: input.endAt,
      location: input.location ?? null,
      conferenceLink: input.conferenceLink ?? null,
      organizer: input.organizer ?? null,
    },
    summary: `Brief for ${input.summary}`,
    guests: input.attendees
      .filter((attendee) => !attendee.resource && !attendee.organizer)
      .map((attendee) => ({
        email: attendee.email,
        name: attendee.displayName ?? null,
        role: null,
        background: null,
        relationshipHistory: [],
        crmContext: null,
        talkingPoints: [],
        uncertainty: [],
        evidenceReferences: [],
      })),
    companies: companyNames.map((name) => ({
      name,
      domain: null,
      hubspotContext: null,
      docs: [],
      news: [],
      industry: [],
      uncertainty: [],
      evidenceReferences: [],
    })),
    conversationStarters: ["What has changed since we last spoke?", "What matters most next?"],
    sourceReferences: [],
    missingEvidence: [],
    uncertainty: [],
  };
}

/** Hermetic system-boundary adapters for the Playwright product journey. */
export function createMeetingBriefTestRuntime(
  options: MeetingBriefTestRuntimeOptions,
): MeetingBriefTestRuntime {
  let now = new Date(options.initialNow);
  const calendar = new FakeCalendarProvider();
  const gmailDelivery = new FakeGmailDeliveryProvider({ ownerEmail: "owner@example.com" });
  const hubSpotConnection = new HubSpotConnection(
    options.configStore,
    () => ({ probe: async () => undefined }),
    () => new Date(now),
  );
  const host = new MeetingBriefHost({
    runs: options.runs,
    workspaceDir: options.workspaceDir,
    configStore: options.configStore,
    now: () => new Date(now),
    calendarProvider: calendar,
    // Matches production, because the journey is the gate that blesses production
    // wiring: "snapshot" exercises both the authoritative snapshot read and the
    // delivery recheck, which is exactly what production enables.
    calendarUse: "snapshot",
    gmailDeliveryProvider: gmailDelivery,
    getOwnerEmail: () => "owner@example.com",
    hubSpotConnection,
    ...(options.personProfiles ? { personProfiles: options.personProfiles } : {}),
    enrich: async (_input, ctx) => {
      ctx.event("fixture_enrich", { provider: "hermetic-system-boundary" });
      return {
        sections: [
          {
            source: "fixture",
            guest: "alice@external.co",
            status: "completed",
            evidence: ["Hermetic relationship evidence"],
            references: ["https://example.com/evidence"],
          },
        ],
        evidence: ["https://example.com/alice", "https://example.com/acme"],
      };
    },
    completeBrief: async (input): Promise<MeetingBrief> => ({
      version: 1,
      eventId: input.eventId,
      occurrenceId: input.occurrenceId,
      eventVersion: input.version,
      generatedAt: now.toISOString(),
      logistics: {
        title: input.summary,
        startAt: input.startAt,
        endAt: input.endAt,
        location: input.location ?? null,
        conferenceLink: input.conferenceLink ?? null,
        organizer: input.organizer ?? null,
      },
      summary: `Brief for ${input.summary}`,
      guests: [
        {
          email: "alice@external.co",
          name: "Alice",
          role: "CTO",
          background: "Hermetic guest background",
          relationshipHistory: ["Prior planning meeting"],
          crmContext: "Acme renewal is active",
          talkingPoints: ["Discuss the next planning milestone"],
          uncertainty: [],
          evidenceReferences: ["https://example.com/alice"],
        },
      ],
      companies: [
        {
          name: "Acme",
          domain: "acme.example",
          hubspotContext: "Active renewal",
          docs: [],
          news: ["Acme announced a new product"],
          industry: [],
          uncertainty: ["Drive Docs for Acme are unavailable"],
          evidenceReferences: ["https://example.com/acme"],
        },
      ],
      conversationStarters: ["What changed since our last meeting?", "What matters most next?"],
      sourceReferences: ["https://example.com/alice", "https://example.com/acme"],
      missingEvidence: ["Drive Docs for Acme"],
      uncertainty: [],
    }),
  });
  return {
    host,
    calendar,
    gmailDelivery,
    hubSpotConnection,
    setNow(value: Date) {
      now = new Date(value);
    },
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
      return new Date(now);
    },
    upsertEvent(event: MeetingBriefEvent) {
      calendar.upsertEvent(toCalendarEvent(event));
    },
  };
}

/** Test-runtime surface: the hermetic host plus the fakes the journey routes observe. */
export interface MeetingBriefTestRuntime {
  host: MeetingBriefHost;
  calendar: FakeCalendarProvider;
  gmailDelivery: FakeGmailDeliveryProvider;
  hubSpotConnection: HubSpotConnection;
  setNow(value: Date): void;
  advance(ms: number): Date;
  upsertEvent(event: MeetingBriefEvent): void;
}

/**
 * Hermetic journey route surface. Registered only when ENABLE_TEST_SEED=1; a production
 * bootstrap never creates the test runtime, so these endpoints do not exist there.
 */
export function registerMeetingBriefTestRoutes(
  app: FastifyInstance,
  runtime: MeetingBriefTestRuntime,
): void {
  const { host } = runtime;
  app.post("/api/test/meeting-brief/schedule", async (request) => {
    const body = request.body as { event?: MeetingBriefEvent; dueAt?: string };
    if (!body.event || typeof body.event !== "object") return { error: "event required" };
    const event = body.event;
    const dueAt = body.dueAt ? new Date(body.dueAt) : new Date();
    runtime.upsertEvent(event);
    host.scheduleOccurrence(event, dueAt);
    return { scheduled: true };
  });
  app.post("/api/test/meeting-brief/process-due", async (request) => {
    const body = request.body as { now?: string };
    const now = body.now ? new Date(body.now) : new Date();
    const created = await host.processDueSchedules(now);
    await host.idle();
    return { created };
  });
  app.post("/api/test/meeting-brief/advance", async (request) => {
    const body = request.body as { ms?: number; now?: string };
    const now = body.now
      ? new Date(body.now)
      : typeof body.ms === "number"
        ? runtime.advance(body.ms)
        : new Date();
    if (body.now) runtime.setNow(now);
    const created = await host.processDueSchedules(now);
    await host.idle();
    await host.recover();
    await host.idle();
    return { now: now.toISOString(), created };
  });
  app.post("/api/test/meeting-brief/set-now", async (request) => {
    const body = request.body as { now?: string | null };
    if (body.now) runtime.setNow(new Date(body.now));
    return { now: body.now ?? null };
  });
  app.get("/api/test/meeting-brief/fake-gmail/messages", async () => {
    return { messages: runtime.gmailDelivery.messages };
  });
  app.post("/api/test/meeting-brief/fake-gmail/clear", async () => {
    runtime.gmailDelivery.clear();
    return { cleared: true };
  });
}

function toCalendarEvent(event: MeetingBriefEvent): CalendarEvent {
  return {
    calendarId: event.calendarId,
    eventId: event.eventId,
    occurrenceId: event.occurrenceId,
    version: event.version,
    summary: event.summary,
    ...(event.description !== undefined ? { description: event.description } : {}),
    startAt: event.startAt,
    endAt: event.endAt,
    location: event.location ?? null,
    conferenceLink: event.conferenceLink ?? null,
    ...(event.organizer !== undefined ? { organizer: event.organizer } : {}),
    attendees: event.attendees,
    status: "confirmed",
    ...(event.attachments !== undefined ? { attachments: event.attachments } : {}),
  };
}
