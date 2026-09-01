import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import fastify from "fastify";
import type { MeetingBriefEvent, MeetingBriefRunResult } from "@chief-of-staff-demo/shared";
import { isGuestProfileEmployerMatch } from "@chief-of-staff-demo/shared";
import { PersonProfileStore } from "../../../apps/server/src/person-profile/store";
import { WorkspacePersonProfiles } from "../../../apps/server/src/person-profile/profiles";
import { openRuns, type Runs } from "../../../apps/server/src/runs";
import { MeetingBriefHost } from "../../../apps/server/src/modules/meeting-brief-generator/host";
import { ConfigStore } from "../../../apps/server/src/config";
import { GuestProfileConnection } from "../../../apps/server/src/modules/meeting-brief-generator/connections/profile";
import { createFakeGuestProfileProvider } from "../../../apps/server/src/modules/meeting-brief-generator/profile/provider";
import { FakeGmailProvider } from "../../../apps/server/src/modules/meeting-brief-generator/google/gmail";
import { FakeCalendarHistoryProvider } from "../../../apps/server/src/modules/meeting-brief-generator/google/calendarHistory";
import { FakeDriveProvider } from "../../../apps/server/src/modules/meeting-brief-generator/google/drive";
import { FakePublicIntelligenceProvider } from "../../../apps/server/src/modules/meeting-brief-generator/enrichment/publicIntelligence";
import type { HubSpotApi } from "../../../apps/server/src/modules/meeting-brief-generator/hubspot/client";
import {
  completeFixtureBrief,
  fixtureGmailDeliveryProvider,
} from "../../../apps/server/src/modules/meeting-brief-generator/testRuntime";

function stubHubSpotApi(): HubSpotApi {
  return {
    async listContacts() {
      return { results: [] };
    },
    async searchContactByEmail() {
      return null;
    },
    async getAssociatedCompanyIds() {
      return [];
    },
    async getCompany() {
      return null;
    },
    async getAssociatedDealIds() {
      return [];
    },
    async getDeal() {
      return null;
    },
    async getAssociatedDealIdsForCompany() {
      return [];
    },
  };
}

const fixtureDeliver = fixtureGmailDeliveryProvider();

function fixtureEvent(overrides: Partial<MeetingBriefEvent> = {}): MeetingBriefEvent {
  return {
    calendarId: "cal_primary",
    eventId: "evt_profile_1",
    occurrenceId: "2026-08-28T15:00:00Z",
    version: "v1",
    summary: "Profile sync",
    startAt: "2026-08-28T15:00:00.000Z",
    endAt: "2026-08-28T15:30:00.000Z",
    attendees: [
      {
        email: "owner@example.com",
        displayName: "Owner",
        responseStatus: "accepted",
        organizer: true,
      },
      { email: "alice@external.co", displayName: "Alice External", responseStatus: "accepted" },
      { email: "bob@external.co", displayName: "Bob External", responseStatus: "needsAction" },
    ],
    ...overrides,
    status: overrides.status ?? "confirmed",
  };
}

describe("Guest Profile connection — per-user endpoint + API key redacted, bounded read-only probe", () => {
  let workspaceDir: string;
  let configStore: ConfigStore;
  let connection: GuestProfileConnection;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "mbf-profile-conn-"));
    const configFile = join(workspaceDir, "config.json");
    configStore = new ConfigStore(configFile);
    configStore.load();
    connection = new GuestProfileConnection(configStore);
  });

  it("status is unconfigured when no endpoint/key, no secret leakage", () => {
    const status = connection.status();
    expect(status.state).toBe("unconfigured");
    expect(status.endpoint).toBeNull();
    expect(status.apiKeyHint).toBe("");
    expect(status.lastVerifiedAt).toBeNull();
    // No secret in status
    expect(JSON.stringify(status)).not.toContain("secret");
  });

  it("connect stores endpoint+key and status redacts key to last 4", () => {
    const status = connection.connect("https://profile.example", "sk-1234567890abcd");
    expect(status.endpoint).toBe("https://profile.example");
    expect(status.apiKeyHint).toBe("…abcd");
    expect(status.state).toBe("unverified");
    const stored = configStore.get().modules["meeting-brief-generator"].guestProfile;
    expect(stored.endpoint).toBe("https://profile.example");
    expect(stored.apiKey).toBe("sk-1234567890abcd");
    // status never leaks full key
    expect(JSON.stringify(status)).not.toContain("sk-1234567890abcd");
  });

  it("verifySetup classifies rejected (401) without marking lastVerifiedAt", async () => {
    connection.connect("https://profile.example", "bad-key");
    const fakeFetch = vi.fn(async () => new Response(null, { status: 401 }));
    const conn2 = new GuestProfileConnection(configStore, fakeFetch);
    const result = await conn2.verifySetup();
    expect(result.state).toBe("rejected");
    expect(connection.status().lastVerifiedAt).toBeNull();
    expect(result.detail.toLowerCase()).toContain("rejected");
  });

  it("verifySetup classifies missing_authority (403)", async () => {
    connection.connect("https://profile.example", "key");
    const fakeFetch = vi.fn(async () => new Response(null, { status: 403 }));
    const conn2 = new GuestProfileConnection(configStore, fakeFetch);
    const result = await conn2.verifySetup();
    expect(result.state).toBe("missing_authority");
  });

  it("verifySetup classifies unavailable (503) and leaves no side effect beyond diagnostics", async () => {
    connection.connect("https://profile.example", "key");
    const fakeFetch = vi.fn(async () => new Response(null, { status: 503 }));
    const conn2 = new GuestProfileConnection(configStore, fakeFetch);
    const result = await conn2.verifySetup();
    expect(result.state).toBe("unavailable");
    expect(connection.status().lastVerifiedAt).toBeNull();
  });

  it("verifySetup healthy (200) marks lastVerifiedAt and is read-only probe", async () => {
    connection.connect("https://profile.example", "good-key");
    const fakeFetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const conn2 = new GuestProfileConnection(
      configStore,
      fakeFetch,
      () => new Date("2026-08-28T09:00:00Z"),
    );
    const result = await conn2.verifySetup();
    expect(result.state).toBe("connected");
    expect(connection.status().lastVerifiedAt).toBe("2026-08-28T09:00:00.000Z");
    expect(fakeFetch).toHaveBeenCalledTimes(1);
    // probe is bounded read-only via fetchProbe(endpoint, apiKey)
    const firstCall = fakeFetch.mock.calls[0] as unknown as [string, string];
    expect(firstCall[0]).toBe("https://profile.example");
  });

  it("disconnect clears endpoint/key and is not leaked", () => {
    connection.connect("https://profile.example", "sk-12345");
    const after = connection.disconnect();
    expect(after.state).toBe("unconfigured");
    expect(after.endpoint).toBeNull();
    expect(configStore.get().modules["meeting-brief-generator"].guestProfile.apiKey).toBe("");
  });
});

describe("Guest Profile enrichment via host seam — bounded per-guest fixed contract + artifacts + Employer Match", () => {
  let workspaceDir: string;
  let runs: Runs;
  let now: Date;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "mbf-profile-host-"));
    runs = openRuns(workspaceDir);
    now = new Date("2026-08-28T09:00:00.000Z");
  });

  it("consumes the pinned Person Profile revision without a Guest Profile endpoint", async () => {
    const store = new PersonProfileStore(workspaceDir);
    const attendeeProfiles = new WorkspacePersonProfiles({
      store,
      now: () => new Date(now),
    });
    store.save({
      id: "person_alice",
      revision: 1,
      createdAt: "2026-08-28T09:00:00.000Z",
      updatedAt: "2026-08-28T09:00:00.000Z",
      fullName: "Alice External",
      primaryEmail: "alice@external.co",
      emails: ["alice@external.co"],
      handles: {},
      profileUrls: ["https://example.com/alice"],
      employerHints: [],
      role: "Founder",
      background: "Builds evidence-backed products",
      currentEmployer: "Example Labs",
      socialProfiles: [],
      websites: ["https://example.com/alice"],
      feeds: [{ url: "https://example.com/alice/feed.xml", title: "Alice's feed" }],
      publications: [],
      mentions: [],
      evidence: [],
      sourceDiagnostics: [{ source: "public-web", status: "completed", detail: "profile matched" }],
      archivedAt: null,
    });
    const host = new MeetingBriefHost({
      runs,
      workspaceDir,
      now: () => new Date(now),
      log: () => {},
      gmailDeliveryProvider: fixtureDeliver,
      completeBrief: completeFixtureBrief,
      getInternalDomains: () => ["example.com"],
      enrichmentProviders: {
        gmailProvider: new FakeGmailProvider(),
        calendarHistoryProvider: new FakeCalendarHistoryProvider(),
        driveProvider: new FakeDriveProvider(),
        attendeeProfiles,
        getHubSpotApi: () => stubHubSpotApi(),
        publicIntelligenceProvider: new FakePublicIntelligenceProvider(),
      },
    });
    const event = fixtureEvent({
      version: "v_person_profile_1",
      attendees: [
        {
          email: "owner@example.com",
          displayName: "Owner",
          responseStatus: "accepted",
          organizer: true,
        },
        {
          email: "alice@external.co",
          displayName: "Alice External",
          responseStatus: "accepted",
        },
      ],
    });
    host.scheduleOccurrence(event, new Date("2026-08-28T11:00:00.000Z"));
    now = new Date("2026-08-28T11:00:00.000Z");
    const [runId] = await host.processDueSchedules(new Date(now));
    await host.idle();

    expect(runs.detail(runId)!.status).toBe("done");
    // The existing Profile was reused, not resolved or duplicated, and the
    // Run pins the exact id + revision it consumed (issue #124).
    expect(store.list()).toHaveLength(2);
    expect(attendeeProfiles.get("person_alice")?.revision).toBe(1);
    const pins = JSON.parse(runs.open(runId)!.readArtifact("attendee-profiles.json")!) as Array<{
      email: string;
      profileId: string;
      profileRevision: number;
      origin: string;
    }>;
    expect(pins).toContainEqual({
      email: "alice@external.co",
      profileId: "person_alice",
      profileRevision: 1,
      origin: "reused",
    });
    expect(runs.detail(runId)!.files).toContain(
      "person-profile-alice_external_co-v_person_profile_1.json",
    );
    const snapshot = JSON.parse(
      runs.open(runId)!.readArtifact("person-profile-alice_external_co-v_person_profile_1.json")!,
    ) as { profileId: string; profileRevision: number; currentEmployer: string | null };
    expect(snapshot.profileId).toBe("person_alice");
    expect(snapshot.profileRevision).toBe(1);
    expect(snapshot.currentEmployer).toBe("Example Labs");
    const result = runs.detail(runId)!.result as MeetingBriefRunResult;
    expect(result.personProfileLinks).toEqual([
      {
        guestEmail: "alice@external.co",
        profileId: "person_alice",
        profileRevision: 1,
      },
    ]);
  });

  it("each External Guest gets bounded lookup via fixed contract; artifacts keyed by version+guest+source with confidence/role/background/employer/refs/diagnostics/outcome", async () => {
    const fake = createFakeGuestProfileProvider({
      "alice@external.co": "exact",
      "bob@external.co": "empty",
    });
    const configFile = join(workspaceDir, "config.json");
    const configStore = new ConfigStore(configFile);
    configStore.load();
    configStore.setModuleConfig("meeting-brief-generator", {
      internalDomains: [],
      guestProfile: {
        endpoint: "https://fake-guest-profile.example",
        apiKey: "fake-key-1234",
        lastVerifiedAt: null,
        lastCheckAt: null,
        lastCheckState: null,
        lastCheckDetail: null,
      },
      hubspot: { token: "", lastVerifiedAt: null },
    });
    const connection = new GuestProfileConnection(configStore);
    const host = new MeetingBriefHost({
      runs,
      workspaceDir,
      now: () => new Date(now),
      log: () => {},
      gmailDeliveryProvider: fixtureDeliver,
      completeBrief: completeFixtureBrief,
      configStore,
      guestProfileConnection: connection,
      enrichmentProviders: {
        gmailProvider: new FakeGmailProvider(),
        calendarHistoryProvider: new FakeCalendarHistoryProvider(),
        driveProvider: new FakeDriveProvider(),
        profileProvider: fake,
        getHubSpotApi: () => stubHubSpotApi(),
        publicIntelligenceProvider: new FakePublicIntelligenceProvider(),
      },
    });
    const event = fixtureEvent({ version: "v_profile_1" });
    const dueAt = new Date("2026-08-28T11:00:00.000Z");
    host.scheduleOccurrence(event, dueAt);
    now = new Date("2026-08-28T11:00:00.000Z");
    const created = await host.processDueSchedules(new Date(now));
    expect(created).toHaveLength(1);
    await host.idle();
    const runId = created[0];
    const detail = runs.detail(runId)!;
    expect(detail.status).toBe("done");
    // Check enrich artifacts: profile files keyed by version+guest+source
    expect(detail.files).toContain("profile-alice_external_co-v_profile_1.json");
    expect(detail.files).toContain("profile-bob_external_co-v_profile_1.json");
    const aliceRaw = runs.open(runId)!.readArtifact("profile-alice_external_co-v_profile_1.json")!;
    const alice = JSON.parse(aliceRaw) as Record<string, unknown>;
    expect(alice.guestEmail).toBe("alice@external.co");
    expect(alice.occurrenceKey).toBe("evt_profile_1::2026-08-28T15:00:00Z");
    expect(alice.eventVersion).toBe("v_profile_1");
    expect(alice.source).toBe("guest-profile");
    expect(alice.outcome).toBe("completed");
    expect(alice.identityConfidence).toBe("high");
    expect(alice.role).toBe("CTO at Fixture Corp");
    expect(alice.background).toBe("10 years building Fixture Corp");
    expect((alice.currentEmployer as { name: string }).name).toBe("Fixture Corp");
    expect(alice.references).toEqual(["https://fixture.example/team"]);
    expect(alice.diagnostics).toBeDefined();
    // Bob empty
    const bobRaw = runs.open(runId)!.readArtifact("profile-bob_external_co-v_profile_1.json")!;
    const bob = JSON.parse(bobRaw) as Record<string, unknown>;
    expect(bob.outcome).toBe("empty");
    expect(bob.currentEmployer).toBeNull();
  });

  it("one unambiguous current-employer = direct Employer Match; ambiguous keeps unresolved and no guessed company", async () => {
    const fakeExact = createFakeGuestProfileProvider({
      "alice@external.co": "exact",
      "bob@external.co": "ambiguous",
    });
    const host = new MeetingBriefHost({
      runs,
      workspaceDir,
      now: () => new Date(now),
      log: () => {},
      gmailDeliveryProvider: fixtureDeliver,
      completeBrief: completeFixtureBrief,
      enrichmentProviders: {
        gmailProvider: new FakeGmailProvider(),
        calendarHistoryProvider: new FakeCalendarHistoryProvider(),
        driveProvider: new FakeDriveProvider(),
        profileProvider: fakeExact,
        getHubSpotApi: () => stubHubSpotApi(),
        publicIntelligenceProvider: new FakePublicIntelligenceProvider(),
      },
    });
    const event = fixtureEvent({
      version: "v_employer_1",
      attendees: [
        {
          email: "owner@example.com",
          displayName: "Owner",
          responseStatus: "accepted",
          organizer: true,
        },
        { email: "alice@external.co", displayName: "Alice", responseStatus: "accepted" },
        { email: "bob@external.co", displayName: "Bob", responseStatus: "accepted" },
      ],
    });
    host.scheduleOccurrence(event, new Date("2026-08-28T11:00:00.000Z"));
    now = new Date("2026-08-28T11:00:00.000Z");
    const [runId] = await host.processDueSchedules(new Date(now));
    await host.idle();
    const aliceArt = JSON.parse(
      runs.open(runId)!.readArtifact("profile-alice_external_co-v_employer_1.json")!,
    );
    const bobArt = JSON.parse(
      runs.open(runId)!.readArtifact("profile-bob_external_co-v_employer_1.json")!,
    );
    expect(isGuestProfileEmployerMatch(aliceArt)).toBe(true);
    expect(isGuestProfileEmployerMatch(bobArt)).toBe(false);
    expect(bobArt.currentEmployer).toBeNull();
    // The unified enrichment output attributes an explicit employer match only to Alice.
    const enrich = JSON.parse(runs.open(runId)!.readArtifact("enrich.json")!) as {
      sections: Array<{ guest?: string; source?: string }>;
    };
    expect(
      enrich.sections.some(
        (section) => section.guest === "alice@external.co" && section.source === "employer-match",
      ),
    ).toBe(true);
    expect(
      enrich.sections.some(
        (section) => section.guest === "bob@external.co" && section.source === "employer-match",
      ),
    ).toBe(false);
  });

  it("fixtures cover 6 response shapes: exact, ambiguous, empty, malformed, rejected, unavailable", async () => {
    const mapping: Record<
      string,
      "exact" | "ambiguous" | "empty" | "malformed" | "rejected" | "unavailable"
    > = {
      "a@external.co": "exact",
      "b@external.co": "ambiguous",
      "c@external.co": "empty",
      "d@external.co": "malformed",
      "e@external.co": "rejected",
      "f@external.co": "unavailable",
    };
    const fake = createFakeGuestProfileProvider(mapping);
    const host = new MeetingBriefHost({
      runs,
      workspaceDir,
      now: () => new Date(now),
      log: () => {},
      gmailDeliveryProvider: fixtureDeliver,
      completeBrief: completeFixtureBrief,
      enrichmentProviders: {
        gmailProvider: new FakeGmailProvider(),
        calendarHistoryProvider: new FakeCalendarHistoryProvider(),
        driveProvider: new FakeDriveProvider(),
        profileProvider: fake,
        getHubSpotApi: () => stubHubSpotApi(),
        publicIntelligenceProvider: new FakePublicIntelligenceProvider(),
      },
    });
    const event = fixtureEvent({
      version: "v_fixtures",
      attendees: [
        {
          email: "owner@example.com",
          displayName: "Owner",
          responseStatus: "accepted",
          organizer: true,
        },
        ...Object.keys(mapping).map((email) => ({
          email,
          displayName: email.split("@")[0],
          responseStatus: "accepted" as const,
        })),
      ],
    });
    host.scheduleOccurrence(event, new Date("2026-08-28T11:00:00.000Z"));
    now = new Date("2026-08-28T11:00:00.000Z");
    const [runId] = await host.processDueSchedules(new Date(now));
    await host.idle();
    const detail = runs.detail(runId)!;
    expect(detail.status).toBe("done");
    for (const [email, fixture] of Object.entries(mapping)) {
      const sanitized = email.replace(/[^a-zA-Z0-9]/g, "_");
      const raw = runs.open(runId)!.readArtifact(`profile-${sanitized}-v_fixtures.json`)!;
      expect(raw).toBeDefined();
      const art = JSON.parse(raw) as {
        outcome: string;
        diagnostics: { statusCode?: number; error?: string };
      };
      if (fixture === "exact") expect(art.outcome).toBe("completed");
      if (fixture === "ambiguous") expect(art.outcome).toBe("completed");
      if (fixture === "empty") expect(art.outcome).toBe("empty");
      if (fixture === "malformed") expect(art.outcome).toBe("failed");
      if (fixture === "rejected") {
        expect(art.outcome).toBe("failed");
        expect(art.diagnostics.statusCode).toBe(401);
      }
      if (fixture === "unavailable") {
        expect(art.outcome).toBe("failed");
        expect(art.diagnostics.statusCode).toBe(503);
      }
    }
  });

  it("no LinkedIn scraping introduced — profile provider uses only fetch, no browser automation", async () => {
    // Assert that the http provider does not import puppeteer/browser and that fake exists
    const fake = createFakeGuestProfileProvider({ "alice@external.co": "exact" });
    expect(fake.id).toBe("guest-profile");
    // Dynamic provider seam should not require cookies or LinkedIn
    const artifact = await fake.lookup({
      guestEmail: "alice@external.co",
      endpoint: "https://fake.example",
      apiKey: "k",
      occurrenceKey: "evt::occ",
      eventVersion: "v1",
    });
    expect(artifact.diagnostics.provider).toBe("Guest Profile");
  });
});

describe("Meeting Brief delivery rechecks pinned Person Profiles", () => {
  it("fails visibly before send, and again on retry, when a repair lands after composition", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "mbf-profile-delivery-"));
    const runs = openRuns(workspaceDir);
    const people = new WorkspacePersonProfiles({
      store: new PersonProfileStore(workspaceDir),
      now: () => new Date("2026-08-28T10:00:00.000Z"),
    });
    const profile = people.create({
      fullName: "Alice External",
      primaryEmail: "alice@external.co",
      role: "CTO",
    });
    let repaired = false;
    let sends = 0;
    const host = new MeetingBriefHost({
      runs,
      workspaceDir,
      now: () => new Date("2026-08-28T11:00:00.000Z"),
      getInternalDomains: () => ["example.com"],
      getOwnerEmail: () => "owner@example.com",
      personProfiles: people,
      enrich: async () => {
        const current = people.get(profile.id)!;
        return {
          sections: [],
          evidence: [],
          personProfileLinks: [
            {
              guestEmail: "alice@external.co",
              profileId: current.id,
              profileRevision: current.revision,
            },
          ],
        };
      },
      completeBrief: completeFixtureBrief,
      gmailDeliveryProvider: {
        async findByDeliveryId() {
          if (!repaired) {
            repaired = true;
            people.correct(profile.id, { role: "Founder", note: "Corrected before delivery." });
          }
          return null;
        },
        async send() {
          sends += 1;
          return { messageId: "must-not-send", recipient: "owner@example.com" };
        },
      },
    });
    const event = fixtureEvent({ version: "v_profile_repair_delivery" });
    host.scheduleOccurrence(event, new Date("2026-08-28T11:00:00.000Z"));
    const [runId] = await host.processDueSchedules(new Date("2026-08-28T11:00:00.000Z"));
    await host.idle();

    expect(runs.detail(runId)).toMatchObject({ status: "failed", failedStage: "deliver" });
    expect((runs.detail(runId)?.result as MeetingBriefRunResult).delivery.status).toBe("failed");
    expect(runs.detail(runId)?.events).toContainEqual(
      expect.objectContaining({
        type: "brief_delivery_blocked",
        detail: expect.objectContaining({ reason: "person_profile_refresh_required" }),
      }),
    );
    expect(sends).toBe(0);

    await expect(host.retryRun(runId)).rejects.toThrow(/require regeneration/);
    expect(runs.detail(runId)).toMatchObject({ status: "failed", failedStage: "deliver" });
    expect(sends).toBe(0);

    const staleArtifact = runs.open(runId)!.readArtifact("result.json");
    const app = fastify({ logger: false });
    await host.routes(app);
    await app.ready();
    const [firstRefresh, concurrentRefresh] = await Promise.all([
      app.inject({
        method: "POST",
        url: `/api/meeting-brief/runs/${runId}/regenerate`,
      }),
      app.inject({
        method: "POST",
        url: `/api/meeting-brief/runs/${runId}/regenerate`,
      }),
    ]);
    expect(firstRefresh.statusCode).toBe(202);
    expect(concurrentRefresh.statusCode).toBe(202);
    const refreshedRunId = firstRefresh.json<{ runId: string }>().runId;
    expect(concurrentRefresh.json<{ runId: string }>().runId).toBe(refreshedRunId);
    expect(refreshedRunId).not.toBe(runId);
    await host.idle();

    expect(runs.detail(refreshedRunId)).toMatchObject({ status: "done", failedStage: null });
    expect(runs.detail(refreshedRunId)?.result as MeetingBriefRunResult).toMatchObject({
      supersedes: runId,
      profileRefreshOf: runId,
      delivery: { status: "sent" },
      personProfileLinks: [{ profileId: profile.id, profileRevision: 2 }],
    });
    expect(sends).toBe(1);
    expect(runs.open(runId)!.readArtifact("result.json")).toBe(staleArtifact);
    expect(runs.detail(runId)).toMatchObject({ status: "failed", failedStage: "deliver" });

    const repeatedRefresh = await app.inject({
      method: "POST",
      url: `/api/meeting-brief/runs/${runId}/regenerate`,
    });
    expect(repeatedRefresh.statusCode).toBe(202);
    expect(repeatedRefresh.json<{ runId: string }>().runId).toBe(refreshedRunId);

    const currentRefresh = await app.inject({
      method: "POST",
      url: `/api/meeting-brief/runs/${refreshedRunId}/regenerate`,
    });
    expect(currentRefresh.statusCode).toBe(409);
    expect(currentRefresh.json()).toMatchObject({
      error: "meeting-brief-profile-refresh-not-required",
    });
    await app.close();
  });

  it("sends one distinct Profile refresh and reconciles that message on retry", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "mbf-profile-refresh-delivery-"));
    const runs = openRuns(workspaceDir);
    const people = new WorkspacePersonProfiles({
      store: new PersonProfileStore(workspaceDir),
      now: () => new Date("2026-08-28T10:00:00.000Z"),
    });
    const profile = people.create({
      fullName: "Alice External",
      primaryEmail: "alice@external.co",
      role: "CTO",
    });
    const sent = new Map<string, { messageId: string; recipient: string }>();
    let sendCalls = 0;
    let refreshedMessageId: string | null = null;
    const host = new MeetingBriefHost({
      runs,
      workspaceDir,
      now: () => new Date("2026-08-28T11:00:00.000Z"),
      getInternalDomains: () => ["example.com"],
      getOwnerEmail: () => "owner@example.com",
      personProfiles: people,
      enrich: async () => {
        const current = people.get(profile.id)!;
        return {
          sections: [],
          evidence: [],
          personProfileLinks: [
            {
              guestEmail: "alice@external.co",
              profileId: current.id,
              profileRevision: current.revision,
            },
          ],
        };
      },
      completeBrief: completeFixtureBrief,
      gmailDeliveryProvider: {
        async findByDeliveryId(deliveryId) {
          return sent.get(deliveryId) ?? null;
        },
        async send({ deliveryId }) {
          sendCalls += 1;
          const delivered = {
            messageId: `message-${sendCalls}`,
            recipient: "owner@example.com",
          };
          sent.set(deliveryId, delivered);
          if (sendCalls === 2) {
            refreshedMessageId = delivered.messageId;
            throw new Error("Lost acknowledgement after refreshed Gmail send");
          }
          return delivered;
        },
      },
    });
    const event = fixtureEvent({ version: "v_profile_refresh_delivery" });
    host.scheduleOccurrence(event, new Date("2026-08-28T11:00:00.000Z"));
    const [originalRunId] = await host.processDueSchedules(new Date("2026-08-28T11:00:00.000Z"));
    await host.idle();
    const original = runs.detail(originalRunId)?.result as MeetingBriefRunResult;
    expect(original.delivery).toMatchObject({ status: "sent", messageId: "message-1" });

    people.correct(profile.id, { role: "Founder", note: "Corrected after original delivery." });
    const app = fastify({ logger: false });
    await host.routes(app);
    await app.ready();
    const response = await app.inject({
      method: "POST",
      url: `/api/meeting-brief/runs/${originalRunId}/regenerate`,
    });
    expect(response.statusCode).toBe(202);
    const refreshedRunId = response.json<{ runId: string }>().runId;
    await host.idle();

    const failedRefresh = runs.detail(refreshedRunId)?.result as MeetingBriefRunResult;
    expect(runs.detail(refreshedRunId)).toMatchObject({ status: "failed", failedStage: "deliver" });
    expect(failedRefresh).toMatchObject({
      profileRefreshOf: originalRunId,
      personProfileLinks: [{ profileId: profile.id, profileRevision: 2 }],
    });
    expect(failedRefresh.delivery.deliveryId).not.toBe(original.delivery.deliveryId);
    expect(sendCalls).toBe(2);
    expect(sent.size).toBe(2);

    await host.retryRun(refreshedRunId);
    await host.idle();

    const reconciledRefresh = runs.detail(refreshedRunId)?.result as MeetingBriefRunResult;
    expect(reconciledRefresh.delivery).toMatchObject({
      status: "reconciled",
      deliveryId: failedRefresh.delivery.deliveryId,
      messageId: refreshedMessageId,
    });
    expect(sendCalls).toBe(2);
    expect(sent.size).toBe(2);
    await app.close();
  });
});
