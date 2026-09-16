import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { WorkspacePersonProfiles } from "../../../apps/server/src/person-profile/profiles.js";
import { PersonProfileStore } from "../../../apps/server/src/person-profile/store.js";

test("stable URL addition creates once without web access and deleted identities cannot be recreated", () => {
  const root = mkdtempSync(join(tmpdir(), "person-entry-"));
  try {
    const people = new WorkspacePersonProfiles({
      store: new PersonProfileStore(root),
      lifecycle: [],
    });
    const created = people.ensureIdentifier("https://github.com/maya");
    expect(created.profileUrls).toEqual(["https://github.com/maya"]);
    expect(people.ensureIdentifier("https://github.com/maya").id).toBe(created.id);
    people.privacyDelete(created.id, { confirmation: "DELETE PROFILE" });
    expect(() => people.ensureIdentifier("https://github.com/maya")).toThrow(/deleted/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dated primary evidence can supersede a manual role correction while retaining its revision", () => {
  const root = mkdtempSync(join(tmpdir(), "person-authority-"));
  try {
    let now = new Date("2026-09-05T00:00:00Z");
    const people = new WorkspacePersonProfiles({
      store: new PersonProfileStore(root),
      lifecycle: [],
      now: () => now,
    });
    const person = people.create({
      fullName: "Maya",
      primaryEmail: "maya@example.com",
      role: "Engineer",
    });
    people.correct(person.id, { role: "Director", note: "My correction" });
    now = new Date("2026-09-07T00:00:00Z");
    expect(
      people.acceptResearchFacts(person.id, 2, [
        {
          field: "role",
          value: "CTO",
          sourceIds: ["official-appointment"],
          effectiveFrom: "2026-09-06",
          authority: "primary-artifact",
          reason: "The official appointment documents the new role effective 6 September.",
        },
      ])?.role,
    ).toBe("CTO");
    expect(people.getRevision(person.id, 2)?.role).toBe("Director");
    expect(people.invalidations(person.id).at(-1)?.detail).toContain("official-appointment");
    expect(
      people.acceptResearchFacts(person.id, 3, [
        {
          field: "role",
          value: "CEO",
          sourceIds: ["bio"],
          effectiveFrom: null,
          authority: "self-report",
          reason: "Retrieved today",
        },
      ])?.role,
    ).toBe("CTO");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a dated primary-artifact fact can supersede a manual correction that was wrong when recorded", () => {
  const root = mkdtempSync(join(tmpdir(), "person-authority-"));
  try {
    const now = new Date("2026-09-05T00:00:00Z");
    const people = new WorkspacePersonProfiles({
      store: new PersonProfileStore(root),
      lifecycle: [],
      now: () => now,
    });
    const person = people.create({
      fullName: "Maya",
      primaryEmail: "maya@example.com",
      role: "Engineer",
    });
    people.correct(person.id, { role: "Director", note: "A mistaken correction" });
    expect(people.get(person.id)?.role).toBe("Director");
    expect(
      people.acceptResearchFacts(person.id, 2, [
        {
          field: "role",
          value: "Engineer",
          sourceIds: ["official-record"],
          effectiveFrom: "2025-01-01",
          authority: "primary-artifact",
          reason: "The official appointment record shows the role never changed.",
        },
      ])?.role,
    ).toBe("Engineer");
    expect(people.getRevision(person.id, 2)?.role).toBe("Director");
    expect(people.invalidations(person.id).at(-1)?.detail).toContain("official-record");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("privacy deletion prevents recreation through a secondary profile URL", () => {
  const root = mkdtempSync(join(tmpdir(), "person-alias-delete-"));
  try {
    const people = new WorkspacePersonProfiles({
      store: new PersonProfileStore(root),
      lifecycle: [],
    });
    const person = people.create({
      primaryEmail: "maya@example.com",
      profileUrls: ["https://example.com/maya"],
    });
    people.privacyDelete(person.id, { confirmation: "DELETE PROFILE" });
    expect(() => people.ensureIdentifier("https://example.com/maya")).toThrow(/deleted/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Audit F4: `ensureIdentifier` matched stored profile URLs as raw strings
 * while `identifier()` hashed the normalized handle, so four spellings of one
 * LinkedIn address produced the same identity digest and still failed to find
 * each other — minting a second record under a `-2` collision suffix that
 * held a different half of the same person's facts. The four spellings are
 * the ones the report names; the slug is a placeholder, because the defect is
 * in the comparison and never in whose address it compares.
 */
test("equivalent identifier spellings reuse one Profile instead of minting a collision suffix", () => {
  const root = mkdtempSync(join(tmpdir(), "person-entry-normalized-"));
  try {
    const people = new WorkspacePersonProfiles({
      store: new PersonProfileStore(root),
      lifecycle: [],
    });
    const created = people.ensureIdentifier("https://www.linkedin.com/in/example-person");
    for (const variant of [
      "https://www.linkedin.com/in/example-person/",
      "HTTPS://WWW.LINKEDIN.COM/in/example-person",
      "  https://www.linkedin.com/in/example-person  ",
    ])
      expect(people.ensureIdentifier(variant).id).toBe(created.id);
    /* The real creation path ran each time, so reuse has to show in the
       record count, not only in the returned id. */
    expect(people.search({ includeArchived: true })).toHaveLength(1);
    expect(created.id).not.toMatch(/-\d+$/);

    /* A different person on the same platform is still a different person. */
    const other = people.ensureIdentifier("https://www.linkedin.com/in/someone-else/");
    expect(other.id).not.toBe(created.id);
    expect(people.search({ includeArchived: true })).toHaveLength(2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Audit F4, existing records: two Profiles that already hold equivalent
 * spellings both match once the lookup is normalized. Neither is chosen,
 * merged, rewritten or archived — the conflict is reported and names them, so
 * the operator decides. This is the behaviour the live Workspace's preserved
 * duplicate pair will meet.
 */
test("pre-existing duplicates that normalize to one identity are reported, never silently resolved", () => {
  const root = mkdtempSync(join(tmpdir(), "person-entry-duplicates-"));
  try {
    const store = new PersonProfileStore(root);
    const people = new WorkspacePersonProfiles({ store, lifecycle: [] });
    const first = people.create({ profileUrls: ["https://www.linkedin.com/in/example-person/"] });
    const second = people.create({ profileUrls: ["https://www.linkedin.com/in/example-person"] });
    expect(second.id).not.toBe(first.id);

    let message = "";
    expect(() => {
      try {
        people.ensureIdentifier("https://www.linkedin.com/in/example-person");
      } catch (error) {
        message = (error as Error).message;
        throw error;
      }
    }).toThrow(/Several Profiles hold that identity/);
    expect(message).toContain(first.id);
    expect(message).toContain(second.id);
    /* Both records survive the refusal untouched. */
    expect(people.search({ includeArchived: true })).toHaveLength(2);
    expect(people.get(first.id)?.archivedAt ?? null).toBeNull();
    expect(people.get(second.id)?.mergedInto ?? null).toBeNull();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("identifier lookup reuses a stored handle even when its profile URL is absent", () => {
  const root = mkdtempSync(join(tmpdir(), "person-entry-handle-"));
  try {
    const people = new WorkspacePersonProfiles({
      store: new PersonProfileStore(root),
      lifecycle: [],
    });
    const person = people.create({ fullName: "Example Person" });
    new PersonProfileStore(root).save({ ...person, handles: { linkedin: ["Example-Person"] } });
    expect(people.ensureIdentifier("https://www.linkedin.com/in/example-person/").id).toBe(
      person.id,
    );
    expect(people.search({ includeArchived: true })).toHaveLength(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
