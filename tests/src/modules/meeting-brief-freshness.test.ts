import { describe, expect, it } from "vitest";
import type {
  MeetingBrief,
  MeetingBriefEnrichmentSection,
  MeetingBriefEvent,
} from "@chief-of-staff-demo/shared";
import { composeBrief } from "../../../apps/server/src/modules/meeting-brief-generator/compose";
import {
  applyFreshnessPolicy,
  claimIdFor,
  classifyContextFreshness,
  freshnessClassFor,
} from "../../../apps/server/src/modules/meeting-brief-generator/freshness";

/**
 * Issue #362 / MWR-050 — freshness windows, dated provenance and explicit
 * uncertainty. Freshness is a check on evidence age, never proof of truth:
 * a contradiction defeats a current assertion even inside its window, a
 * missing date stays unknown, and historical relationship evidence keeps its
 * event date instead of becoming current when it is read again.
 */

const NOW = new Date("2026-09-11T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * DAY).toISOString();
}

function hoursAgo(hours: number): string {
  return new Date(NOW.getTime() - hours * HOUR).toISOString();
}

function profileSection(
  publishedAt: string | null,
  employer: string,
): MeetingBriefEnrichmentSection {
  return {
    source: "person-profile",
    guest: "alice@external.co",
    status: "completed",
    evidence: [`${employer} — CTO`],
    references: ["https://acme.example/alice"],
    provenance: {
      retrievedAt: null,
      publishedAt,
      claimId: claimIdFor("current-employer", "alice@external.co"),
      claimValue: employer,
      evidenceDates: [publishedAt],
    },
  };
}

function hubspotMatchSection(retrievedAt: string, employer: string): MeetingBriefEnrichmentSection {
  return {
    source: "employer-match",
    guest: "alice@external.co",
    company: employer,
    status: "completed",
    evidence: [`HubSpot company ${employer} associated to alice@external.co`],
    references: ["https://app.hubspot.com/companies/1"],
    provenance: {
      retrievedAt,
      publishedAt: null,
      claimId: claimIdFor("current-employer", "alice@external.co"),
      claimValue: employer,
    },
  };
}

const SNAPSHOT: MeetingBriefEvent & { occurrenceKey: string } = {
  occurrenceKey: "evt_fresh::2026-09-12T15:00:00Z",
  calendarId: "primary",
  eventId: "evt_fresh",
  occurrenceId: "2026-09-12T15:00:00Z",
  version: "v1",
  summary: "Acme renewal",
  startAt: "2026-09-12T15:00:00.000Z",
  endAt: "2026-09-12T15:30:00.000Z",
  organizer: { email: "owner@example.com", displayName: "Owner" },
  attendees: [
    { email: "alice@external.co", displayName: "Alice", responseStatus: "accepted" },
    {
      email: "owner@example.com",
      displayName: "Owner",
      responseStatus: "accepted",
      organizer: true,
    },
  ],
  attachments: [],
  status: "confirmed",
};

/** A model answer that confidently presents the profile facts as current. */
function modelAnswer(): () => unknown {
  return () =>
    Promise.resolve({
      summary: "Renewal conversation with Acme.",
      guests: [
        {
          email: "alice@external.co",
          name: "Alice",
          role: "CTO",
          background: null,
          relationshipHistory: [],
          crmContext: null,
          talkingPoints: [],
          uncertainty: [],
          evidenceReferences: ["https://acme.example/alice"],
        },
      ],
      companies: [],
      conversationStarters: ["How is the renewal tracking?", "What changed since last quarter?"],
      sourceReferences: ["https://acme.example/alice"],
      missingEvidence: [],
      uncertainty: [],
    });
}

async function composeWith(sections: MeetingBriefEnrichmentSection[]): Promise<MeetingBrief> {
  return composeBrief({
    now: () => NOW,
    getCompleteJson: () => modelAnswer() as never,
    snapshot: SNAPSHOT,
    sections,
    internalDomains: ["example.com"],
  });
}

describe("freshness classification (issue #362)", () => {
  it("keeps a current-role claim current inside the seven-day window and expired outside it", () => {
    const fresh = classifyContextFreshness([profileSection(daysAgo(5), "Acme")], { now: NOW });
    expect(fresh.items).toHaveLength(1);
    expect(fresh.items[0]).toMatchObject({
      state: "current",
      class: "current-role-company",
      windowHours: 168,
      asOf: daysAgo(5),
      qualification: null,
    });

    const stale = classifyContextFreshness([profileSection(daysAgo(9), "Acme")], { now: NOW });
    expect(stale.items[0]?.state).toBe("expired");
    expect(stale.items[0]?.qualification).toContain("older than the 168h freshness window");
    expect(stale.items[0]?.qualification).toContain(daysAgo(9));
  });

  it("applies the 48-hour news window to news and conversation hooks", () => {
    const newsSection = (publishedAt: string): MeetingBriefEnrichmentSection => ({
      source: "company-news",
      guest: "alice@external.co",
      company: "Acme",
      status: "completed",
      evidence: ["Acme announced a new product"],
      references: ["https://news.example/acme"],
      provenance: {
        retrievedAt: hoursAgo(1),
        publishedAt,
        claimId: claimIdFor("news", "acme"),
        claimValue: null,
        evidenceDates: [publishedAt],
      },
    });
    const current = classifyContextFreshness([newsSection(hoursAgo(30))], { now: NOW });
    expect(current.items[0]).toMatchObject({ state: "current", windowHours: 48 });

    const expired = classifyContextFreshness([newsSection(hoursAgo(60))], { now: NOW });
    expect(expired.items[0]?.state).toBe("expired");
  });

  it("treats a missing date as unknown freshness, never current", () => {
    const undated = classifyContextFreshness(
      [
        {
          source: "hubspot-contact",
          guest: "alice@external.co",
          status: "completed",
          evidence: ["HubSpot contact for alice@external.co"],
          references: ["https://app.hubspot.com/contacts/1"],
          provenance: {
            retrievedAt: null,
            publishedAt: null,
            claimId: claimIdFor("current-role", "alice@external.co"),
            claimValue: null,
          },
        },
      ],
      { now: NOW },
    );
    expect(undated.items[0]).toMatchObject({ state: "unknown", asOf: null });
    expect(undated.unknown[0]).toContain("no known date");
  });

  it("keeps historical relationship evidence on its event date and never promotes it", () => {
    const fresh = freshnessClassFor("gmail-exact");
    expect(fresh).toBe("historical-relationship");
    const classified = classifyContextFreshness(
      [
        {
          source: "calendar-history",
          guest: "alice@external.co",
          status: "completed",
          evidence: ["Prior renewal conversation"],
          references: ["https://calendar.google.com/event?eid=1"],
          provenance: {
            // Read a minute ago, but the meeting itself was months ago.
            retrievedAt: hoursAgo(0.016),
            publishedAt: null,
            claimId: claimIdFor("relationship-history", "alice@external.co"),
            claimValue: null,
            evidenceDates: ["2026-01-05T10:00:00.000Z"],
          },
        },
      ],
      { now: NOW },
    );
    expect(classified.items[0]).toMatchObject({
      state: "historical",
      asOf: "2026-01-05T10:00:00.000Z",
      windowHours: null,
    });
    expect(classified.items[0]?.qualification).toContain("not a current fact");
  });

  it("contradiction defeats a current assertion even inside the window", () => {
    const classified = classifyContextFreshness(
      [profileSection(daysAgo(1), "Acme"), hubspotMatchSection(hoursAgo(2), "Globex")],
      { now: NOW },
    );
    expect(classified.items.map((item) => item.state)).toEqual(["conflicting", "conflicting"]);
    expect(classified.conflicting[0]).toContain("Acme vs Globex");
    expect(classified.items[0]?.qualification).toContain("no current value is asserted");
  });

  it("honours facts a source declares unknown or conflicting", () => {
    const declaredConflict = classifyContextFreshness(
      [
        {
          source: "person-profile",
          guest: "alice@external.co",
          status: "completed",
          evidence: ["Acme — CTO"],
          references: ["https://acme.example/alice"],
          provenance: {
            retrievedAt: daysAgo(1),
            publishedAt: daysAgo(1),
            claimId: claimIdFor("current-employer", "alice@external.co"),
            claimValue: "Acme",
            conflicting: ["HubSpot lists Globex"],
            unknown: ["start date"],
          },
        },
      ],
      { now: NOW },
    );
    expect(declaredConflict.items[0]?.state).toBe("conflicting");
    expect(declaredConflict.items[0]?.qualification).toContain("no current value is asserted");
  });

  it("windows are configurable, not constants", () => {
    const sections = [profileSection(daysAgo(2), "Acme")];
    const strict = classifyContextFreshness(sections, {
      now: NOW,
      windows: { currentRoleCompanyHours: 24 },
    });
    expect(strict.items[0]?.state).toBe("expired");
    expect(strict.windows.currentRoleCompanyHours).toBe(24);
    expect(strict.windows.newsConversationHookHours).toBe(48);
  });
});

describe("freshness policy on the composed Brief (issue #362)", () => {
  it("defeats an expired current-role claim and discloses why", async () => {
    const brief = await composeWith([profileSection(daysAgo(30), "Acme")]);
    expect(brief.guests[0]?.role).toBeNull();
    expect(brief.guests[0]?.uncertainty.join(" ")).toContain("verify");
    expect(brief.contextFreshness?.items[0]).toMatchObject({
      state: "expired",
      claimId: claimIdFor("current-employer", "alice@external.co"),
    });
    // The dated record carries the same qualification a reader sees on the guest.
    expect(brief.contextFreshness?.items[0]?.qualification).toContain("older than the 168h");
  });

  it("withholds an undated role and states what was known and why", async () => {
    const brief = await composeWith([profileSection(null, "Acme")]);
    // Undated evidence is not presented as the person's current role.
    expect(brief.guests[0]?.role).toBeNull();
    const disclosure = brief.guests[0]?.uncertainty.join(" ") ?? "";
    expect(disclosure).toContain("no known date");
    expect(disclosure).toContain("not asserted as current");
    expect(disclosure).toContain("Acme");
    expect(brief.contextFreshness?.items[0]?.state).toBe("unknown");
  });

  it("keeps undated news unknown rather than dating it by when it was searched", () => {
    const classified = classifyContextFreshness(
      [
        {
          source: "company-news",
          guest: "alice@external.co",
          company: "Acme",
          status: "completed",
          evidence: ["Acme announced a new product"],
          references: ["https://news.example/acme"],
          provenance: {
            // Searched a minute ago; the result states no publication date.
            retrievedAt: hoursAgo(0.02),
            publishedAt: null,
            claimId: claimIdFor("news", "acme"),
            claimValue: null,
            evidenceDates: [null],
          },
        },
      ],
      { now: NOW },
    );
    expect(classified.items[0]).toMatchObject({ state: "unknown", asOf: null });
    expect(classified.items[0]?.qualification).toContain("no known date");
  });

  it("does not assert either employer when two fresh sources disagree", async () => {
    const brief = await composeWith([
      profileSection(daysAgo(1), "Acme"),
      hubspotMatchSection(hoursAgo(2), "Globex"),
    ]);
    expect(brief.guests[0]?.role).toBeNull();
    expect(brief.contextFreshness?.conflicting.join(" ")).toContain("no current value is asserted");
  });

  it("leaves a fresh claim alone and records it as current", async () => {
    const brief = await composeWith([profileSection(daysAgo(2), "Acme")]);
    expect(brief.guests[0]?.role).toBe("CTO");
    expect(brief.contextFreshness?.items[0]?.state).toBe("current");
    expect(brief.contextFreshness?.items[0]?.qualification).toBeNull();
  });

  it("treats sections without provenance as unknown rather than inventing a date", () => {
    const legacy: MeetingBriefEnrichmentSection = {
      source: "person-profile",
      guest: "alice@external.co",
      status: "completed",
      evidence: ["Acme — CTO"],
      references: ["https://acme.example/alice"],
    };
    const classified = classifyContextFreshness([legacy], { now: NOW });
    expect(classified.items[0]).toMatchObject({ state: "unknown", asOf: null, windowHours: 168 });
    const brief: MeetingBrief = {
      version: 1,
      eventId: "evt_fresh",
      occurrenceId: SNAPSHOT.occurrenceId,
      eventVersion: "v1",
      generatedAt: NOW.toISOString(),
      logistics: {
        title: "Acme renewal",
        startAt: SNAPSHOT.startAt,
        endAt: SNAPSHOT.endAt,
        location: null,
        conferenceLink: null,
        organizer: null,
      },
      summary: "Renewal",
      guests: [
        {
          email: "alice@external.co",
          name: "Alice",
          role: "CTO",
          background: null,
          relationshipHistory: [],
          crmContext: null,
          talkingPoints: [],
          uncertainty: [],
          evidenceReferences: [],
        },
      ],
      companies: [],
      conversationStarters: ["a", "b"],
      sourceReferences: [],
      missingEvidence: [],
      uncertainty: [],
    };
    const applied = applyFreshnessPolicy(brief, classified);
    // Legacy sections have no date at all, so the claim is withheld and the
    // Brief says which value it declined to assert.
    expect(applied.guests[0]?.role).toBeNull();
    expect(applied.guests[0]?.uncertainty.join(" ")).toContain("no known date");
    expect(applied.contextFreshness?.items[0]?.state).toBe("unknown");
  });
});
