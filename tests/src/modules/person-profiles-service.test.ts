import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PersonEvidence, PersonProfile } from "@chief-of-staff-demo/shared";
import { PersonProfileStore } from "../../../apps/server/src/person-profile/store";
import {
  PersonProfileValidationError,
  WorkspacePersonProfiles,
} from "../../../apps/server/src/person-profile/profiles";

/**
 * The Person Profiles deep interface (spec #117, Deep interfaces item 1): its
 * observable operations — search, explicit creation, current/exact-revision
 * retrieval, and purpose-specific projections — are the test surface. Matching
 * indexes, revision writes, and provenance bookkeeping stay behind it.
 */
const NOW = new Date("2026-08-31T16:00:00.000Z");

function makeService(dir = mkdtempSync(join(tmpdir(), "person-profiles-svc-"))) {
  return new WorkspacePersonProfiles({
    store: new PersonProfileStore(dir),
    now: () => NOW,
  });
}

function evidence(overrides: Partial<PersonEvidence>): PersonEvidence {
  return {
    id: "ev_1",
    source: "public-web",
    kind: "publication",
    title: "A published talk",
    summary: "Spoke about evidence-backed identity.",
    url: "https://example.com/talks/identity",
    identitySignals: { emails: [], fullNames: [], handles: {}, profileUrls: [], employerHints: [] },
    claims: {},
    matchConfidence: "high",
    matchedSignals: ["fullName:ada lovelace"],
    observedAt: "2026-08-30T08:00:00.000Z",
    ...overrides,
  };
}

function richProfile(overrides: Partial<PersonProfile> = {}): PersonProfile {
  return {
    id: "person_ada",
    revision: 2,
    createdAt: "2026-08-29T08:00:00.000Z",
    updatedAt: "2026-08-30T08:00:00.000Z",
    fullName: "Ada Lovelace",
    primaryEmail: "ada@example.com",
    emails: ["ada@example.com"],
    handles: { bluesky: ["ada"] },
    profileUrls: ["https://example.com/~ada"],
    employerHints: ["Analytical Engines Ltd"],
    role: "Engineer",
    background: "Writes about computation.",
    currentEmployer: "Analytical Engines Ltd",
    socialProfiles: [{ platform: "bluesky", handle: "ada", url: "https://bsky.app/profile/ada" }],
    websites: ["https://example.com/~ada"],
    feeds: [{ url: "https://example.com/~ada/feed.xml", title: "Ada's notes" }],
    publications: [evidence({})],
    mentions: [
      evidence({
        id: "ev_mention",
        kind: "mention",
        url: "https://news.example.com/ada-profile",
        title: "Someone wrote about Ada",
      }),
    ],
    evidence: [
      evidence({}),
      evidence({
        id: "ev_identity",
        kind: "identity",
        source: "hubspot",
        title: "CRM contact record",
        url: "https://app.hubspot.com/contacts/1",
        identitySignals: {
          emails: ["ada@example.com"],
          fullNames: [],
          handles: {},
          profileUrls: [],
          employerHints: [],
        },
      }),
    ],
    sourceDiagnostics: [{ source: "public-web", status: "completed", detail: "3 results" }],
    archivedAt: null,
    ...overrides,
  };
}

describe("WorkspacePersonProfiles.search", () => {
  it("finds active profiles by name, email, and employer, case-insensitively", () => {
    const profiles = makeService();
    const created = profiles.create({
      fullName: "Grace Hopper",
      primaryEmail: "grace@example.com",
      currentEmployer: "US Navy",
    });
    expect(profiles.search({ query: "grace hopper" }).map((p) => p.id)).toEqual([created.id]);
    expect(profiles.search({ query: "GRACE@EXAMPLE.COM" }).map((p) => p.id)).toEqual([created.id]);
    expect(profiles.search({ query: "navy" }).map((p) => p.id)).toEqual([created.id]);
    expect(profiles.search({ query: "nobody" })).toEqual([]);
  });

  it("searches archived Profiles only when the caller asks for them", () => {
    const store = new PersonProfileStore(mkdtempSync(join(tmpdir(), "person-profiles-arch-")));
    store.save(richProfile({ id: "person_ada", archivedAt: "2026-08-30T09:00:00.000Z" }));
    const profiles = new WorkspacePersonProfiles({ store, now: () => NOW });

    expect(profiles.search({ query: "ada" })).toEqual([]);
    const found = profiles.search({ query: "ada", includeArchived: true });
    expect(found).toHaveLength(1);
    expect(found[0].archivedAt).toBe("2026-08-30T09:00:00.000Z");
  });
});

describe("WorkspacePersonProfiles.create", () => {
  it("creates a canonical Profile with an auditable first revision", () => {
    const profiles = makeService();
    const created = profiles.create({
      fullName: "Grace Hopper",
      primaryEmail: "grace@example.com",
      role: "Rear Admiral",
      currentEmployer: "US Navy",
    });

    expect(created.revision).toBe(1);
    expect(created.createdAt).toBe(NOW.toISOString());
    expect(created.updatedAt).toBe(NOW.toISOString());
    expect(created.fullName).toBe("Grace Hopper");
    expect(created.primaryEmail).toBe("grace@example.com");
    expect(created.emails).toEqual(["grace@example.com"]);
    expect(created.archivedAt).toBeNull();
    // The first revision is on disk exactly as returned, so the audit trail
    // starts at the creation moment itself.
    expect(profiles.getRevision(created.id, 1)).toEqual(created);
  });

  it("validates identity inputs and names the problem", () => {
    const profiles = makeService();

    expect(() => profiles.create({})).toThrow(PersonProfileValidationError);
    try {
      profiles.create({});
    } catch (error) {
      expect((error as PersonProfileValidationError).code).toBe("missing-identity-input");
    }
    try {
      profiles.create({ primaryEmail: "not-an-email" });
    } catch (error) {
      expect((error as PersonProfileValidationError).code).toBe("invalid-identity-input");
    }
    try {
      profiles.create({ fullName: "   " });
    } catch (error) {
      expect((error as PersonProfileValidationError).code).toBe("missing-identity-input");
    }
  });

  it("refuses to overwrite an existing canonical identity", () => {
    const profiles = makeService();
    const created = profiles.create({
      fullName: "Grace Hopper",
      primaryEmail: "grace@example.com",
    });
    const reread = profiles.get(created.id)!;

    expect(() =>
      profiles.create({ fullName: "Grace Hopper", primaryEmail: "grace@example.com" }),
    ).toThrow(PersonProfileValidationError);
    // The refusal is durable: the stored profile was never touched.
    expect(profiles.get(created.id)).toEqual(reread);
    expect(profiles.getRevision(created.id, 2)).toBeNull();
  });

  it("lets two same-named people exist when a name is the only signal", () => {
    // A name alone is review material (spec #117), never an automatic identity collision.
    const profiles = makeService();
    const first = profiles.create({ fullName: "Alex Chen" });
    const second = profiles.create({ fullName: "Alex Chen" });
    expect(second.id).not.toBe(first.id);
    expect(profiles.search({ query: "alex chen" })).toHaveLength(2);
  });
});

describe("WorkspacePersonProfiles revision retrieval", () => {
  it("returns the current revision and any exact historical revision", () => {
    const store = new PersonProfileStore(mkdtempSync(join(tmpdir(), "person-profiles-rev-")));
    store.save(richProfile({ revision: 1, currentEmployer: "Analytical Engines Ltd" }));
    const current = richProfile({ revision: 2, currentEmployer: "Analytical Engines Co" });
    store.save(current);
    const profiles = new WorkspacePersonProfiles({ store, now: () => NOW });

    expect(profiles.get("person_ada")).toEqual(current);
    expect(profiles.getRevision("person_ada", 1)?.currentEmployer).toBe("Analytical Engines Ltd");
    expect(profiles.getRevision("person_ada", 2)?.currentEmployer).toBe("Analytical Engines Co");
    expect(profiles.getRevision("person_ada", 3)).toBeNull();
    expect(profiles.get("person_unknown")).toBeNull();

    expect(profiles.revisions("person_ada").map((p) => p.revision)).toEqual([1, 2]);
    expect(profiles.revisions("person_unknown")).toEqual([]);
  });

  it("serves Profiles persisted before revisioned storage kept only current.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "person-profiles-legacy-"));
    const root = join(dir, "person-profiles", "person_legacy");
    mkdirSync(root, { recursive: true });
    const legacy = richProfile({ revision: 3 });
    writeFileSync(join(root, "current.json"), `${JSON.stringify(legacy, null, 2)}\n`);
    const profiles = new WorkspacePersonProfiles({
      store: new PersonProfileStore(dir),
      now: () => NOW,
    });

    expect(profiles.revisions("person_legacy").map((p) => p.revision)).toEqual([3]);
    expect(profiles.getRevision("person_legacy", 3)).toEqual(legacy);
    expect(profiles.project("public-safe", "person_legacy")?.profileRevision).toBe(3);
  });
});

describe("WorkspacePersonProfiles projections", () => {
  it("public-safe projection carries public facts and publishing surfaces only", () => {
    const store = new PersonProfileStore(mkdtempSync(join(tmpdir(), "person-profiles-pub-")));
    store.save(richProfile());
    const profiles = new WorkspacePersonProfiles({ store, now: () => NOW });

    const projection = profiles.project("public-safe", "person_ada");
    expect(projection?.projectionVersion).toBe(1);
    expect(projection?.profileId).toBe("person_ada");
    expect(projection?.profileRevision).toBe(2);
    if (projection?.purpose !== "public-safe") throw new Error("expected public-safe projection");
    expect(projection.fullName).toBe("Ada Lovelace");
    expect(projection.role).toBe("Engineer");
    expect(projection.currentEmployer).toBe("Analytical Engines Ltd");
    expect(projection.background).toBe("Writes about computation.");
    expect(projection.socialProfiles).toHaveLength(1);
    expect(projection.websites).toEqual(["https://example.com/~ada"]);
    expect(projection.feeds).toEqual([
      { url: "https://example.com/~ada/feed.xml", title: "Ada's notes" },
    ]);
    expect(projection.publications).toHaveLength(1);
    // Provenance and confidence survive; the private payload around them does not.
    expect(projection.publications[0]).toMatchObject({
      source: "public-web",
      url: "https://example.com/talks/identity",
      matchConfidence: "high",
    });
    const rendered = JSON.stringify(projection);
    expect(rendered).not.toContain("ada@example.com");
    expect(rendered).not.toContain("hubspot");
    expect(rendered).not.toContain("CRM contact record");
    expect(rendered).not.toContain("news.example.com");
    expect(rendered).not.toContain('public-web", "status"');
  });

  it("meeting projection carries contact and evidence but not enrichment plumbing", () => {
    const store = new PersonProfileStore(mkdtempSync(join(tmpdir(), "person-profiles-meet-")));
    store.save(richProfile());
    const profiles = new WorkspacePersonProfiles({ store, now: () => NOW });

    const projection = profiles.project("meeting", "person_ada");
    if (projection?.purpose !== "meeting") throw new Error("expected meeting projection");
    expect(projection.projectionVersion).toBe(1);
    expect(projection.primaryEmail).toBe("ada@example.com");
    expect(projection.emails).toEqual(["ada@example.com"]);
    expect(projection.mentions).toHaveLength(1);
    expect(projection.evidence.map((item) => item.kind)).toEqual(
      expect.arrayContaining(["publication", "identity"]),
    );
    expect(projection.evidence[0].matchConfidence).toBe("high");
    const rendered = JSON.stringify(projection);
    expect(rendered).not.toContain("status"); // source diagnostics stay behind the interface
    expect(rendered).not.toContain("employerHints");
  });

  it("pins an exact historical revision and returns null for unknown profiles", () => {
    const store = new PersonProfileStore(mkdtempSync(join(tmpdir(), "person-profiles-pin-")));
    store.save(richProfile({ revision: 1, role: "Mathematician" }));
    store.save(richProfile({ revision: 2, role: "Engineer" }));
    const profiles = new WorkspacePersonProfiles({ store, now: () => NOW });

    const pinned = profiles.project("public-safe", "person_ada", { revision: 1 });
    expect(pinned?.profileRevision).toBe(1);
    if (pinned?.purpose !== "public-safe") throw new Error("expected public-safe projection");
    expect(pinned.role).toBe("Mathematician");

    expect(profiles.project("public-safe", "person_unknown")).toBeNull();
    expect(profiles.project("meeting", "person_ada", { revision: 9 })).toBeNull();
  });
});
