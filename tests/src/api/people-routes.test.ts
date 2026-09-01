import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PersonProfile } from "@chief-of-staff-demo/shared";
import { registerPeopleApi } from "../../../apps/server/src/api/people";
import { PersonProfileStore } from "../../../apps/server/src/person-profile/store";
import { WorkspacePersonProfiles } from "../../../apps/server/src/person-profile/profiles";

/**
 * The product namespace `/api/people/*` (spec #117): the same observable
 * Profile operations the module interface exposes, over a real server and a
 * temporary Workspace. No provider is reachable here — creation and retrieval
 * are Workspace-local operations.
 */
let app: FastifyInstance;
let workspaceDir: string;
let profiles: WorkspacePersonProfiles;
let store: PersonProfileStore;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "cos-people-routes-"));
  store = new PersonProfileStore(workspaceDir);
  profiles = new WorkspacePersonProfiles({
    store,
    now: () => new Date("2026-08-31T16:00:00.000Z"),
  });
  app = fastify();
  registerPeopleApi(app, { people: profiles });
  return app.ready();
});

afterEach(async () => {
  await app.close();
});

async function createGrace(): Promise<PersonProfile> {
  const response = await app.inject({
    method: "POST",
    url: "/api/people",
    payload: { fullName: "Grace Hopper", primaryEmail: "grace@example.com" },
  });
  expect(response.statusCode).toBe(201);
  return response.json<PersonProfile>();
}

describe("POST /api/people", () => {
  it("creates a Profile and returns its canonical state with the first revision", async () => {
    const created = await createGrace();
    expect(created.revision).toBe(1);
    expect(created.fullName).toBe("Grace Hopper");
    expect(created.primaryEmail).toBe("grace@example.com");
    expect(created.archivedAt).toBeNull();
  });

  it("classifies invalid identity inputs as 400, naming the problem", async () => {
    const missing = await app.inject({ method: "POST", url: "/api/people", payload: {} });
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toMatchObject({ error: "missing-identity-input" });

    const invalid = await app.inject({
      method: "POST",
      url: "/api/people",
      payload: { primaryEmail: "not-an-email" },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ error: "invalid-identity-input" });

    const duplicate = await createGrace();
    const again = await app.inject({
      method: "POST",
      url: "/api/people",
      payload: { fullName: "Grace Hopper", primaryEmail: "grace@example.com" },
    });
    expect(again.statusCode).toBe(400);
    expect(again.json()).toMatchObject({ error: "duplicate-profile" });
    expect(profiles.get(duplicate.id)?.revision).toBe(1);
  });
});

describe("GET /api/people", () => {
  it("lists Profiles and applies the search query and archive filter", async () => {
    const created = await createGrace();
    const listed = await app.inject({ url: "/api/people" });
    expect(listed.json<PersonProfile[]>()).toHaveLength(1);

    const missed = await app.inject({ url: "/api/people?query=nobody" });
    expect(missed.json<PersonProfile[]>()).toEqual([]);

    const hit = await app.inject({ url: "/api/people?query=GRACE" });
    expect(hit.json<PersonProfile[]>()).toHaveLength(1);

    // An archived Profile stays out until the caller asks for archived state.
    store.save({ ...profiles.get(created.id)!, archivedAt: "2026-08-31T15:00:00.000Z" });
    const active = await app.inject({ url: "/api/people" });
    expect(active.json<PersonProfile[]>()).toEqual([]);
    const withArchived = await app.inject({ url: "/api/people?includeArchived=true" });
    expect(withArchived.json<PersonProfile[]>()).toHaveLength(1);
  });
});

describe("GET /api/people/:profileId", () => {
  it("returns the current Profile state and 404 for an unknown one", async () => {
    const created = await createGrace();
    const found = await app.inject({ url: `/api/people/${created.id}` });
    expect(found.statusCode).toBe(200);
    expect(found.json<PersonProfile>()).toEqual(created);

    const missing = await app.inject({ url: "/api/people/person_unknown" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: "profile-not-found" });
  });
});

describe("GET /api/people/:profileId/revisions", () => {
  it("lists every revision oldest-first and serves each exact revision", async () => {
    const created = await createGrace();
    const corrected: PersonProfile = {
      ...profiles.get(created.id)!,
      revision: 2,
      role: "Rear Admiral",
      updatedAt: "2026-08-31T17:00:00.000Z",
    };
    store.save(corrected);

    const list = await app.inject({ url: `/api/people/${created.id}/revisions` });
    expect(list.json<PersonProfile[]>().map((p) => p.revision)).toEqual([1, 2]);

    const first = await app.inject({ url: `/api/people/${created.id}/revisions/1` });
    expect(first.statusCode).toBe(200);
    expect(first.json<PersonProfile>().role).toBeNull();

    const second = await app.inject({ url: `/api/people/${created.id}/revisions/2` });
    expect(second.json<PersonProfile>().role).toBe("Rear Admiral");

    const unknown = await app.inject({ url: `/api/people/${created.id}/revisions/3` });
    expect(unknown.statusCode).toBe(404);

    const malformed = await app.inject({ url: `/api/people/${created.id}/revisions/two` });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toMatchObject({ error: "invalid-revision" });
  });
});

describe("GET /api/people/:profileId/projection", () => {
  it("serves purpose-specific projections and pins an exact revision on request", async () => {
    const created = await createGrace();

    const meeting = await app.inject({
      url: `/api/people/${created.id}/projection?purpose=meeting`,
    });
    expect(meeting.statusCode).toBe(200);
    expect(meeting.json()).toMatchObject({ purpose: "meeting", projectionVersion: 1 });
    expect(meeting.json().primaryEmail).toBe("grace@example.com");

    const publicSafe = await app.inject({
      url: `/api/people/${created.id}/projection?purpose=public-safe`,
    });
    expect(publicSafe.statusCode).toBe(200);
    const rendered = publicSafe.body;
    expect(rendered).not.toContain("grace@example.com");

    const pinned = await app.inject({
      url: `/api/people/${created.id}/projection?purpose=meeting&revision=1`,
    });
    expect(pinned.json()).toMatchObject({ profileRevision: 1 });

    const badPurpose = await app.inject({
      url: `/api/people/${created.id}/projection?purpose=everything`,
    });
    expect(badPurpose.statusCode).toBe(400);
    expect(badPurpose.json()).toMatchObject({ error: "invalid-purpose" });

    const badRevision = await app.inject({
      url: `/api/people/${created.id}/projection?purpose=meeting&revision=9`,
    });
    expect(badRevision.statusCode).toBe(404);

    const unknownProfile = await app.inject({
      url: "/api/people/person_unknown/projection?purpose=meeting",
    });
    expect(unknownProfile.statusCode).toBe(404);
  });
});
