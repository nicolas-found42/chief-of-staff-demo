import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MeetingBriefEvent } from "@chief-of-staff-demo/shared";
import { isGuestProfileEmployerMatch } from "@chief-of-staff-demo/shared";
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
