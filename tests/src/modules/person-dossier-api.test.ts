import Fastify from "fastify";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { registerPersonDossierApi } from "../../../apps/server/src/api/person-dossiers.js";
import { PersonDossierStore } from "../../../apps/server/src/person-profile/dossier-store.js";
import { PersonResearchQueue } from "../../../apps/server/src/person-profile/research-queue.js";
import { PersonResearch } from "../../../apps/server/src/person-profile/research.js";
import { WorkspacePersonProfiles } from "../../../apps/server/src/person-profile/profiles.js";
import { PersonProfileStore } from "../../../apps/server/src/person-profile/store.js";

test("owner can inspect research states, change research bounds, and enqueue without waiting for the web", async () => {
  const root = mkdtempSync(join(tmpdir(), "dossier-api-"));
  const app = Fastify();
  try {
    const people = new WorkspacePersonProfiles({
      store: new PersonProfileStore(root),
      lifecycle: [],
    });
    const person = people.create({ primaryEmail: "maya@example.com" });
    const dossiers = new PersonDossierStore(root);
    const research = new PersonResearch({
      dossiers,
      search: async () => [],
      complete: async () => ({}),
    });
    const queue = new PersonResearchQueue({
      workspaceDir: root,
      people,
      research,
      readiness: () => ({ state: "ready" as const, reason: "ready" as const }),
    });
    registerPersonDossierApi(app, { people, dossiers, queue });
    const response = await app.inject({ method: "POST", url: `/api/people/${person.id}/research` });
    expect(response.statusCode).toBe(202);
    expect(response.json().research.state).toBe("queued");
    const settings = await app.inject({
      method: "PATCH",
      url: "/api/people/research/settings",
      payload: { profileCalls: 12, paused: true },
    });
    expect(settings.json().settings.profileCalls).toBe(12);
    expect(settings.json().settings.paused).toBe(true);
    /* A patch names only what the owner changed (#207): editing the refresh
       interval must not carry the rest of the form back as a fresh pause, and
       must not silently unpause research either. */
    const narrowed = await app.inject({
      method: "PATCH",
      url: "/api/people/research/settings",
      payload: { refreshHours: 24 },
    });
    expect(narrowed.json().settings.refreshHours).toBe(24);
    expect(narrowed.json().settings.profileCalls).toBe(12);
    expect(narrowed.json().settings.paused).toBe(true);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: "/api/people/research/settings",
          payload: { paused: false },
        })
      ).json().settings.paused,
    ).toBe(false);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: "/api/people/research/settings",
          payload: { profileCalls: -1 },
        })
      ).statusCode,
    ).toBe(400);
    const read = await app.inject(`/api/people/${person.id}/dossier`);
    expect(read.json().dossier).toBeNull();
    expect(read.json().research.state).toBe("queued");
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Typed API status codes (issue #418, T3; #417 F1): 202 only for genuinely
 * accepted work, a typed 409 `research-disabled` with the actual blocker and
 * a Settings next action when setup is missing, and a distinct retryable 503
 * `research-initializing` while readiness is unresolved. A dossier read
 * stays a 200 read either way.
 */
test("POST /research returns 409 research-disabled with a Settings next action when setup is missing", async () => {
  const root = mkdtempSync(join(tmpdir(), "dossier-api-disabled-"));
  const app = Fastify();
  try {
    const people = new WorkspacePersonProfiles({
      store: new PersonProfileStore(root),
      lifecycle: [],
    });
    const person = people.create({ primaryEmail: "maya@example.com" });
    const dossiers = new PersonDossierStore(root);
    const research = new PersonResearch({
      dossiers,
      search: async () => [],
      complete: async () => ({}),
    });
    const queue = new PersonResearchQueue({
      workspaceDir: root,
      people,
      research,
      readiness: () => ({
        state: "setup-required" as const,
        reason: "owner-not-confirmed" as const,
        nextAction: { label: "Open Settings", href: "/settings" },
      }),
    });
    registerPersonDossierApi(app, { people, dossiers, queue });

    const response = await app.inject({ method: "POST", url: `/api/people/${person.id}/research` });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: "research-disabled",
      readiness: { state: "setup-required", reason: "owner-not-confirmed" },
      nextAction: { label: "Open Settings", href: "/settings" },
    });
    /* Not accepted: no job exists at all. */
    expect(queue.job(person.id)).toBeNull();

    const summary = await app.inject(`/api/people/${person.id}/research/summary`);
    expect(summary.statusCode).toBe(200);
    expect(summary.json()).toEqual({
      summary: null,
      readiness: {
        state: "setup-required",
        reason: "owner-not-confirmed",
        nextAction: { label: "Open Settings", href: "/settings" },
      },
    });

    /* A dossier read stays a read: the same blocked readiness is exposed
       without turning it into an error. */
    const read = await app.inject(`/api/people/${person.id}/dossier`);
    expect(read.statusCode).toBe(200);
    expect(read.json().researchDecision).toMatchObject({ kind: "rejected-readiness" });
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("POST /research returns a distinct retryable 503 research-initializing while readiness is unresolved", async () => {
  const root = mkdtempSync(join(tmpdir(), "dossier-api-initializing-"));
  const app = Fastify();
  try {
    const people = new WorkspacePersonProfiles({
      store: new PersonProfileStore(root),
      lifecycle: [],
    });
    const person = people.create({ primaryEmail: "maya@example.com" });
    const dossiers = new PersonDossierStore(root);
    const research = new PersonResearch({
      dossiers,
      search: async () => [],
      complete: async () => ({}),
    });
    const queue = new PersonResearchQueue({
      workspaceDir: root,
      people,
      research,
      readiness: () => ({
        state: "initializing" as const,
        reason: "owner-identity-unresolved" as const,
      }),
    });
    registerPersonDossierApi(app, { people, dossiers, queue });

    const response = await app.inject({ method: "POST", url: `/api/people/${person.id}/research` });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: "research-initializing",
      readiness: { state: "initializing", reason: "owner-identity-unresolved" },
    });
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("POST /research still 404s an unknown Profile and 409s an inactive one before ever asking the queue", async () => {
  const root = mkdtempSync(join(tmpdir(), "dossier-api-inactive-"));
  const app = Fastify();
  try {
    const people = new WorkspacePersonProfiles({
      store: new PersonProfileStore(root),
      lifecycle: [],
    });
    const person = people.create({ primaryEmail: "maya@example.com" });
    people.archive(person.id);
    const dossiers = new PersonDossierStore(root);
    const research = new PersonResearch({
      dossiers,
      search: async () => [],
      complete: async () => ({}),
    });
    const queue = new PersonResearchQueue({
      workspaceDir: root,
      people,
      research,
      readiness: () => ({ state: "ready" as const, reason: "ready" as const }),
    });
    registerPersonDossierApi(app, { people, dossiers, queue });

    expect(
      (await app.inject({ method: "POST", url: `/api/people/person_absent/research` })).statusCode,
    ).toBe(404);
    const archived = await app.inject({ method: "POST", url: `/api/people/${person.id}/research` });
    expect(archived.statusCode).toBe(409);
    expect(archived.json()).toEqual({ error: "profile-inactive" });
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * New status/diagnostics polling interfaces are side-effect-free and never
 * enqueue work (issue #418, T5, spec §7).
 */
test("GET /research/summary and /research/diagnostics are side-effect-free, bounded, and 404 an unknown Profile", async () => {
  const root = mkdtempSync(join(tmpdir(), "dossier-api-summary-"));
  const app = Fastify();
  try {
    const people = new WorkspacePersonProfiles({
      store: new PersonProfileStore(root),
      lifecycle: [],
    });
    const person = people.create({ primaryEmail: "maya@example.com" });
    const dossiers = new PersonDossierStore(root);
    const research = new PersonResearch({
      dossiers,
      search: async () => [],
      complete: async () => ({}),
    });
    const queue = new PersonResearchQueue({
      workspaceDir: root,
      people,
      research,
      readiness: () => ({ state: "ready" as const, reason: "ready" as const }),
    });
    registerPersonDossierApi(app, { people, dossiers, queue });

    expect((await app.inject(`/api/people/person_absent/research/summary`)).statusCode).toBe(404);
    expect((await app.inject(`/api/people/person_absent/research/diagnostics`)).statusCode).toBe(
      404,
    );

    const beforeSummary = await app.inject(`/api/people/${person.id}/research/summary`);
    expect(beforeSummary.statusCode).toBe(200);
    expect(beforeSummary.json()).toEqual({
      summary: null,
      readiness: { state: "ready", reason: "ready" },
    });
    /* Reading the summary never enqueues (unlike GET /dossier, whose
       "viewed" scheduling side effect is a distinct, deliberate decision). */
    expect(queue.job(person.id)).toBeNull();

    const diagnostics = await app.inject(`/api/people/${person.id}/research/diagnostics`);
    expect(diagnostics.statusCode).toBe(200);
    expect(diagnostics.json()).toBeNull();
    expect(queue.job(person.id)).toBeNull();

    await app.inject({ method: "POST", url: `/api/people/${person.id}/research` });
    const afterSummary = await app.inject(`/api/people/${person.id}/research/summary`);
    expect(afterSummary.json().summary).toMatchObject({ profileId: person.id, state: "queued" });
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test.each(["queued", "retrieving"])(
  "detaching %s evidence preserves revisions and excludes late research after restart",
  async (phase) => {
    const root = mkdtempSync(join(tmpdir(), "dossier-detach-api-"));
    const app = Fastify();
    try {
      const people = new WorkspacePersonProfiles({
        store: new PersonProfileStore(root),
        lifecycle: [],
      });
      const person = people.create({ primaryEmail: "maya@example.com" });
      const other = people.create({ primaryEmail: "ada@example.com" });
      const dossiers = new PersonDossierStore(root);
      const source = dossiers.retainSource({
        url: "https://example.com/atlas",
        title: "Atlas notes",
        author: null,
        publishedAt: null,
        retrievedAt: "2026-09-14",
        text: "Maya built Atlas.",
        family: "example.com",
        sourceClass: "primary-artifact",
        visibility: "public",
        completeness: "full",
        access: "retrieved",
        acquisition: "public-web",
      });
      const content = {
        sourceIds: [source.id],
        claims: [],
        works: [],
        expertise: [],
        connections: [],
        sections: [],
      };
      const original = dossiers.publish(person.id, 0, content);
      dossiers.publish(other.id, 0, content);
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const queue = new PersonResearchQueue({
        workspaceDir: root,
        people,
        research: new PersonResearch({
          dossiers,
          search: async () => {
            started.resolve();
            await release.promise;
            return [{ title: source.title, url: source.url, snippet: source.text }];
          },
          complete: async () => {
            throw new Error("Late model dispatch");
          },
        }),
        readiness: () => ({ state: "ready" as const, reason: "ready" as const }),
      });
      registerPersonDossierApi(app, { people, dossiers, queue });
      await app.inject({ method: "POST", url: `/api/people/${person.id}/research` });
      expect(queue.job(person.id)?.state).toBe("queued");
      const tick = phase === "retrieving" ? queue.tick(person.id) : Promise.resolve();
      if (phase === "retrieving") {
        await started.promise;
        expect(queue.job(person.id)?.state).toBe("researching");
      }
      const response = await app.inject({
        method: "POST",
        url: `/api/people/${person.id}/sources/${source.id}/detach`,
      });
      expect(response.statusCode).toBe(200);
      release.resolve();
      await tick;
      expect(response.json().dossier.sourceIds).toEqual([]);
      expect(queue.job(person.id)).toBeNull();
      expect((await app.inject(`/api/people/${person.id}/sources/${source.id}`)).statusCode).toBe(
        404,
      );
      expect((await app.inject(`/api/people/${other.id}/sources/${source.id}`)).statusCode).toBe(
        200,
      );
      expect((await app.inject(`/api/people/${person.id}/dossier/revisions/1`)).json()).toEqual(
        original,
      );
      const restarted = new PersonDossierStore(root);
      expect(restarted.getRevision(person.id, 1)).toEqual(original);
      expect(() => restarted.publish(person.id, 1, content)).toThrow(
        "Dossier changed during research",
      );
      expect(() => restarted.publish(person.id, 2, content)).toThrow("Rejected attribution");
      expect(restarted.source(person.id, source.id)).toBeNull();
      expect(restarted.source(other.id, source.id)?.text).toBe(source.text);
    } finally {
      await app.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
