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

test("research does not re-crawl a source the owner detached", async () => {
  const root = mkdtempSync(join(tmpdir(), "research-rejected-"));
  roots.push(root);
  const people = new WorkspacePersonProfiles({
    store: new PersonProfileStore(root),
    lifecycle: [],
  });
  const person = people.create({ fullName: "Maya Chen", primaryEmail: "maya@example.com" });
  const dossiers = new PersonDossierStore(root);
  const body = "Contact maya@example.com. Maya designed the Atlas scheduler.";
  const complete = async () => ({
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
    works: [],
    expertise: [],
    connections: [],
    sections: [],
  });
  const result = { url: "https://example.com/maya", title: "Maya", snippet: "" };
  const research = new PersonResearch({
    dossiers,
    search: async () => [result],
    fetch: async (url) => ({
      url,
      status: 200,
      contentType: "text/plain",
      etag: null,
      lastModified: null,
      retryAfter: null,
      body,
    }),
    complete,
  });
  await research.run(person, {
    maxCalls: 3,
    maxMilliseconds: 10000,
    reserve: () => true,
    active: () => true,
  });
  const sourceId = dossiers.get(person.id)!.sourceIds[0];
  dossiers.detach(person.id, sourceId);
  people.forgetResearchSource(person.id, sourceId);

  const fetched: string[] = [];
  const next = new PersonResearch({
    dossiers,
    search: async () => [result],
    fetch: async (url) => {
      fetched.push(url);
      return {
        url,
        status: 200,
        contentType: "text/plain",
        etag: null,
        lastModified: null,
        retryAfter: null,
        body,
      };
    },
    complete,
  });
  const outcome = await next.run(person, {
    maxCalls: 3,
    maxMilliseconds: 10000,
    reserve: () => true,
    active: () => true,
  });
  expect(fetched).toEqual([]);
  expect(outcome.diagnostics).toEqual([
    { url: "https://example.com/maya", stage: "attribution", reason: expect.any(String) },
  ]);
  expect(outcome.state).not.toBe("unavailable");
});

test("a source rejected during a run is an attribution diagnostic rather than a failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "research-midrun-"));
  roots.push(root);
  const people = new WorkspacePersonProfiles({
    store: new PersonProfileStore(root),
    lifecycle: [],
  });
  const person = people.create({ fullName: "Maya Chen", primaryEmail: "maya@example.com" });
  const dossiers = new PersonDossierStore(root);
  const body = "Contact maya@example.com. Maya designed the Atlas scheduler.";
  const result = { url: "https://example.com/maya", title: "Maya", snippet: "" };
  const complete = async () => ({
    fullName: null,
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
    works: [],
    expertise: [],
    connections: [],
    sections: [],
  });
  const fetchResponse = (url: string) => ({
    url,
    status: 200,
    contentType: "text/plain",
    etag: null,
    lastModified: null,
    retryAfter: null,
    body,
  });
  const research = new PersonResearch({
    dossiers,
    search: async () => [result],
    fetch: async (url) => fetchResponse(url),
    complete,
  });
  await research.run(person, {
    maxCalls: 3,
    maxMilliseconds: 10000,
    reserve: () => true,
    active: () => true,
  });
  const sourceId = dossiers.get(person.id)!.sourceIds[0];

  const midrun = new PersonResearch({
    dossiers,
    search: async () => [result],
    fetch: async (url) => {
      dossiers.detach(person.id, sourceId);
      people.forgetResearchSource(person.id, sourceId);
      return fetchResponse(url);
    },
    complete,
  });
  const outcome = await midrun.run(person, {
    maxCalls: 6,
    maxMilliseconds: 10000,
    reserve: () => true,
    active: () => true,
  });
  expect(outcome.diagnostics).toContainEqual({
    url: "https://example.com/maya",
    stage: "attribution",
    reason: expect.any(String),
  });
  expect(outcome.state).toBe("empty");
});

test("retains an anchored retrieved source when extraction fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "research-retained-"));
  roots.push(root);
  const people = new WorkspacePersonProfiles({
    store: new PersonProfileStore(root),
    lifecycle: [],
  });
  const person = people.create({ fullName: "Maya Chen", primaryEmail: "maya@example.com" });
  const dossiers = new PersonDossierStore(root);
  const research = new PersonResearch({
    dossiers,
    search: async () => [{ url: "https://example.com/maya", title: "Maya", snippet: "" }],
    fetch: async (url) => ({
      url,
      status: 200,
      contentType: "text/plain",
      etag: null,
      lastModified: null,
      retryAfter: null,
      body: "maya@example.com built Atlas.",
    }),
    complete: async () => {
      throw new Error("model unavailable");
    },
  });
  await research.run(person, {
    maxCalls: 3,
    maxMilliseconds: 10000,
    reserve: () => true,
    active: () => true,
  });
  const dossier = dossiers.get(person.id);
  expect(dossier?.sourceIds).toHaveLength(1);
  expect(dossier?.claims).toHaveLength(0);
  expect(dossiers.source(person.id, dossier!.sourceIds[0])?.text).toBe(
    "maya@example.com built Atlas.",
  );
});

test("source revisions keep one work identity and dated current facts supersede older open-ended claims", async () => {
  const root = mkdtempSync(join(tmpdir(), "research-version-"));
  roots.push(root);
  const people = new WorkspacePersonProfiles({
    store: new PersonProfileStore(root),
    lifecycle: [],
  });
  const person = people.create({ primaryEmail: "maya@example.com" });
  const dossiers = new PersonDossierStore(root);
  let year = "2024";
  const quote = () =>
    `maya@example.com is ${year === "2024" ? "Engineer" : "CTO"} and built Atlas.`;
  const research = new PersonResearch({
    dossiers,
    search: async () => [{ url: "https://example.com/maya", title: "Maya", snippet: "" }],
    fetch: async (url) => ({
      url,
      status: 200,
      contentType: "text/plain",
      etag: null,
      lastModified: null,
      retryAfter: null,
      body: quote(),
    }),
    complete: async () => ({
      fullName: null,
      employer: null,
      sourceClass: "primary-artifact",
      author: null,
      publishedAt: null,
      claims: [
        {
          id: "role",
          section: "career",
          statement: quote(),
          fact: { field: "role", value: year === "2024" ? "Engineer" : "CTO" },
          status: "supported",
          nature: "statement",
          matchConfidence: "high",
          effectiveFrom: `${year}-01-01`,
          effectiveTo: null,
          citations: [{ sourceId: "source", quote: quote() }],
          supports: [],
          supersedes: [],
          changeReason: "Official appointment effective on the stated date.",
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
          claimIds: ["role"],
          contribution: { text: "Built Atlas", claimIds: ["role"] },
          teamContribution: null,
          authority: [],
          scale: [],
          constraints: [],
          outcomes: [],
        },
      ],
      expertise: [],
      connections: [],
      sections: [],
    }),
  });
  const allowance = {
    maxCalls: 3,
    maxMilliseconds: 10000,
    reserve: () => true,
    active: () => true,
  };
  await research.run(person, allowance);
  const first = dossiers.get(person.id)!;
  year = "2025";
  await research.run(person, allowance);
  const current = dossiers.get(person.id)!;
  expect(current.works).toHaveLength(1);
  expect(current.works[0].id).toBe(first.works[0].id);
  expect(current.works[0].claimIds).toHaveLength(2);
  expect(current.claims.find((claim) => claim.fact?.value === "Engineer")).toMatchObject({
    status: "superseded",
    effectiveTo: "2025-01-01",
  });
  expect(current.claims.find((claim) => claim.fact?.value === "CTO")?.supersedes).toContain(
    first.claims[0].id,
  );
  expect(dossiers.getRevision(person.id, first.revision)?.claims[0].status).toBe("supported");
});
