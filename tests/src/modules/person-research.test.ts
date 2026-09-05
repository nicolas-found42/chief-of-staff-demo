import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { PersonDossierStore } from "../../../apps/server/src/person-profile/dossier-store.js";
import { PersonResearch } from "../../../apps/server/src/person-profile/research.js";
import { WorkspacePersonProfiles } from "../../../apps/server/src/person-profile/profiles.js";
import { PersonProfileStore } from "../../../apps/server/src/person-profile/store.js";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
test("automatic research retains a full page and publishes exact grounded work before returning", async () => {
  const root = mkdtempSync(join(tmpdir(), "research-"));
  roots.push(root);
  const people = new WorkspacePersonProfiles({
    store: new PersonProfileStore(root),
    lifecycle: [],
  });
  const person = people.create({ fullName: "Maya Chen", primaryEmail: "maya@example.com" });
  const dossiers = new PersonDossierStore(root);
  const research = new PersonResearch({
    dossiers,
    search: async () => [
      { url: "https://example.com/maya", title: "Maya", snippet: "Short biography" },
    ],
    fetch: async (url) => ({
      url,
      status: 200,
      contentType: "text/plain",
      etag: null,
      lastModified: null,
      retryAfter: null,
      body: "Contact maya@example.com. Maya designed the Atlas scheduler.",
    }),
    complete: async () => ({
      fullName: "Maya Chen",
      employer: null,
      sourceClass: "primary-artifact",
      author: null,
      publishedAt: null,
      claims: [
        {
          id: "scheduler",
          section: "work",
          statement: "Maya designed the Atlas scheduler.",
          status: "supported",
          nature: "statement",
          matchConfidence: "high",
          effectiveFrom: null,
          effectiveTo: null,
          citations: [{ sourceId: "source", quote: "Maya designed the Atlas scheduler." }],
          supports: [],
          supersedes: [],
          changeReason: null,
        },
      ],
      works: [
        {
          id: "atlas",
          title: "Atlas",
          url: "https://example.com/atlas",
          kind: "system",
          startedAt: null,
          endedAt: null,
          claimIds: ["scheduler"],
          contribution: { text: "Designed the scheduler", claimIds: ["scheduler"] },
          teamContribution: null,
          authority: [],
          scale: [],
          constraints: [],
          outcomes: [],
        },
        { id: "unsupported", title: "Unsupported project", claimIds: [] },
      ],
      expertise: [],
      connections: [],
      sections: [],
    }),
  });
  const outcome = await research.run(person, {
    maxCalls: 3,
    maxMilliseconds: 10000,
    reserve: () => true,
    active: () => true,
  });
  expect(outcome.state).toBe("incomplete");
  const dossier = dossiers.get(person.id)!;
  expect(dossier.works[0]?.contribution?.text).toBe("Designed the scheduler");
  const passage = dossier.claims[0].citations[0];
  expect(dossiers.source(person.id, passage.sourceId)?.text).toContain("Contact maya@example.com");
});

test("competing current role statements remain contested and do not silently replace the Profile", async () => {
  const root = mkdtempSync(join(tmpdir(), "research-conflict-"));
  roots.push(root);
  const people = new WorkspacePersonProfiles({
    store: new PersonProfileStore(root),
    lifecycle: [],
  });
  const person = people.create({ primaryEmail: "maya@example.com", role: "Engineer" });
  const dossiers = new PersonDossierStore(root);
  const text = (url: string) =>
    `maya@example.com holds the ${url.endsWith("one") ? "CTO" : "Director"} role.`;
  const research = new PersonResearch({
    people,
    dossiers,
    search: async () =>
      ["one", "two"].map((path) => ({
        url: `https://example.com/${path}`,
        title: path,
        snippet: "",
      })),
    fetch: async (url) => ({
      url,
      status: 200,
      contentType: "text/plain",
      etag: null,
      lastModified: null,
      retryAfter: null,
      body: text(url),
    }),
    complete: async (request) => {
      const url = (JSON.parse(request.user) as { document: { url: string } }).document.url;
      return {
        fullName: null,
        employer: null,
        sourceClass: "primary-artifact",
        author: null,
        publishedAt: null,
        claims: [
          {
            id: "role",
            section: "context",
            statement: text(url),
            fact: { field: "role", value: url.endsWith("one") ? "CTO" : "Director" },
            status: "supported",
            nature: "statement",
            matchConfidence: "high",
            effectiveFrom: "2024-01-01",
            effectiveTo: null,
            citations: [{ sourceId: "source", quote: text(url) }],
            supports: [],
            supersedes: [],
            changeReason: "Official role statement",
          },
        ],
        works: [],
        expertise: [],
        connections: [],
        sections: [],
      };
    },
  });
  await research.run(person, {
    maxCalls: 6,
    maxMilliseconds: 10000,
    reserve: () => true,
    active: () => true,
  });
  expect(dossiers.get(person.id)?.claims.map((c) => c.status)).toEqual(["contested", "contested"]);
  expect(people.get(person.id)?.role).toBe("Engineer");
});

test("confirmed Transcript evidence populates the owner's dossier without leaking into public projections", async () => {
  const root = mkdtempSync(join(tmpdir(), "research-private-"));
  roots.push(root);
  const people = new WorkspacePersonProfiles({
    store: new PersonProfileStore(root),
    lifecycle: [],
  });
  const person = people.create({ fullName: "Maya" });
  const dossiers = new PersonDossierStore(root);
  const quote = "Maya recommended pausing the confidential deployment.";
  const research = new PersonResearch({
    people,
    dossiers,
    search: async () => [],
    privateDocuments: () => [
      {
        transcriptId: "meeting-private",
        text: quote,
        title: "Private meeting",
        active: () => true,
      },
    ],
    complete: async () => ({
      fullName: "Maya",
      employer: null,
      sourceClass: "primary-artifact",
      author: null,
      publishedAt: null,
      claims: [
        {
          id: "private",
          section: "work",
          statement: quote,
          status: "supported",
          nature: "statement",
          matchConfidence: "high",
          effectiveFrom: null,
          effectiveTo: null,
          citations: [{ sourceId: "source", quote }],
          supports: [],
          supersedes: [],
          changeReason: null,
        },
      ],
      works: [],
      expertise: [],
      connections: [],
      sections: [],
    }),
  });
  await research.run(person, {
    maxCalls: 3,
    maxMilliseconds: 10000,
    reserve: () => true,
    active: () => true,
  });
  expect(dossiers.get(person.id)?.claims[0]?.statement).toContain("confidential deployment");
  expect(dossiers.project(person.id, "public")?.claims).toEqual([]);
  dossiers.removeTranscript("meeting-private");
  expect(dossiers.get(person.id)?.claims).toEqual([]);
});
