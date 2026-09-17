import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { PersonDossierStore } from "../../../apps/server/src/person-profile/dossier-store.js";
import { WorkspacePersonProfiles } from "../../../apps/server/src/person-profile/profiles.js";
import { PersonProfileStore } from "../../../apps/server/src/person-profile/store.js";
import { PersonResearch } from "../../../apps/server/src/person-profile/research.js";
import { PersonResearchQueue } from "../../../apps/server/src/person-profile/research-queue.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("explicit research reads a new seed observation while restart preserves legacy evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "research-legacy-title-"));
  roots.push(root);
  const people = new WorkspacePersonProfiles({
    store: new PersonProfileStore(root),
    lifecycle: [],
  });
  const seedUrl = "https://example.com/people/mc";
  const person = people.create({ profileUrls: [seedUrl] });
  const dossiers = new PersonDossierStore(root);
  const legacyText = "Leads operations and builds reliable systems across several markets.";
  let fresh = false;
  let now = new Date("2026-09-01T12:00:00Z");
  const reads: string[] = [];
  const extracted: string[] = [];
  const searches: (string | null)[] = [];
  const research = new PersonResearch({
    people,
    dossiers,
    now: () => now,
    seeds: () => [],
    search: async (_query, request) => {
      searches.push(request?.fullName ?? null);
      return [];
    },
    fetch: async (url) => {
      reads.push(url);
      return {
        url,
        status: url === seedUrl ? 200 : 404,
        contentType: fresh ? "text/html" : "text/plain",
        etag: null,
        lastModified: null,
        retryAfter: null,
        body:
          url !== seedUrl
            ? ""
            : fresh
              ? `<!doctype html><html><head><title>Maya Chen — public profile</title></head><body><article><p>${legacyText.repeat(5)}</p></article></body></html>`
              : legacyText,
      };
    },
    complete: async (request) => {
      extracted.push(request.user);
      if (!fresh) throw new Error("controlled extraction interruption");
      return {
        fullName: request.user.includes("Page title: Maya Chen") ? "Maya Chen" : null,
        employer: null,
        sourceClass: "self-report",
        author: null,
        publishedAt: null,
        claims: [],
        works: [],
        expertise: [],
        connections: [],
        sections: [],
      };
    },
  });
  const deps = {
    workspaceDir: root,
    people,
    research,
    now: () => now,
    readiness: () => ({ state: "ready" as const, reason: "ready" as const }),
  };
  const first = new PersonResearchQueue(deps);
  first.configure({ paused: false, profileCalls: 10, profileMilliseconds: 10000 });
  first.enqueue(person.id, "created");
  await first.tick();
  expect(first.job(person.id)?.state).toBe("interrupted");
  const oldSourceId = dossiers.get(person.id)!.sourceIds[0];
  const oldSource = dossiers.source(person.id, oldSourceId)!;
  expect(oldSource.text).toBe(legacyText);
  expect(oldSource.text).not.toContain("Maya Chen");
  const oldBytes = readFileSync(join(root, "person-source-documents", `${oldSourceId}.json`));
  const seedReads = () => reads.filter((url) => url === seedUrl).length;
  expect(seedReads()).toBe(1);

  // A restart is continuation, not permission to recapture or rewrite evidence.
  now = new Date("2026-09-02T12:00:00Z");
  const resumed = new PersonResearchQueue(deps);
  const extractionBeforeResume = extracted.length;
  await resumed.tick();
  expect(seedReads()).toBe(1);
  expect(extracted[extractionBeforeResume]).toContain(legacyText);
  expect(extracted[extractionBeforeResume]).not.toContain("Page title:");
  expect(readFileSync(join(root, "person-source-documents", `${oldSourceId}.json`))).toEqual(
    oldBytes,
  );

  // Only a deliberate request may observe the later public page. Its title is
  // new evidence, not metadata that can be backfilled onto the earlier capture.
  fresh = true;
  now = new Date("2026-09-03T12:00:00Z");
  const extractionStart = extracted.length;
  const searchStart = searches.length;
  resumed.enqueue(person.id, "explicit");
  await resumed.tick();
  expect(seedReads()).toBe(2);
  expect(extracted[extractionStart]).toContain("Page title: Maya Chen — public profile");
  expect(people.get(person.id)?.fullName).toBe("Maya Chen");
  expect(searches.slice(searchStart)).toContain("Maya Chen");
  expect(searches.slice(searchStart)).not.toContain(null);
  expect(readFileSync(join(root, "person-source-documents", `${oldSourceId}.json`))).toEqual(
    oldBytes,
  );
  const sources = dossiers.get(person.id)!.sourceIds.map((id) => dossiers.source(person.id, id)!);
  expect(sources).toContainEqual(oldSource);
  expect(sources).toContainEqual(
    expect.objectContaining({
      text: expect.stringContaining("Page title: Maya Chen"),
      retrievedAt: now.toISOString(),
    }),
  );
});
