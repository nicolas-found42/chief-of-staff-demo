import { mkdtempSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { loadCorpus } from "../../../apps/server/src/person-benchmark/corpus";
import { evaluatePerson } from "../../../apps/server/src/person-benchmark/evaluate";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("does not count a judge's unsupported recovery of an empty dossier", async () => {
  const person = loadCorpus(
    fileURLToPath(new URL("../../../benchmark/person-research/people", import.meta.url)),
  ).people.find((entry) => entry.slug === "achim-steiner")!;
  const workspaceDir = mkdtempSync(join(tmpdir(), "benchmark-report-"));
  roots.push(workspaceDir);
  const { result } = await evaluatePerson(person, "live-discovery", {
    workspaceDir,
    search: async () => [],
    complete: () => async () => ({}),
    judge: async ({ user }) => {
      if (user.includes('"references":'))
        return {
          judgements: person.facts.map((fact) => ({
            factId: fact.id,
            verdict: "recovered",
            evidence: null,
            claimId: null,
            rationale: "I know this fact from general knowledge.",
          })),
        };
      return {
        understanding: 0,
        remainingQuestions: 0,
        conversationReadiness: 0,
        rationale: "Empty dossier.",
        uncertain: false,
        overclaims: [],
      };
    },
  });
  expect(result.richness.claims).toBe(0);
  expect(result.completeness.recovered).toBe(0);
  expect(result.completeness.judgements).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ verdict: "ambiguous", reviewRequired: true }),
    ]),
  );
});

it("reports an interrupted production operation as an evaluation failure", async () => {
  const person = loadCorpus(
    fileURLToPath(new URL("../../../benchmark/person-research/people", import.meta.url)),
  ).people.find((entry) => entry.slug === "achim-steiner")!;
  const workspaceDir = mkdtempSync(join(tmpdir(), "benchmark-interrupted-"));
  roots.push(workspaceDir);
  const { result } = await evaluatePerson(person, "fixed-documents", {
    workspaceDir,
    search: async () => [],
    complete: () => async () => {
      throw new Error("Model provider unavailable");
    },
    judge: async ({ user }) =>
      user.includes('"references":')
        ? { judgements: [] }
        : {
            understanding: 0,
            remainingQuestions: 0,
            conversationReadiness: 0,
            rationale: "No published claims.",
            uncertain: false,
            overclaims: [],
          },
  });
  expect(result.operational.conclusion).toBe("interrupted");
  expect(result.failure).toMatch(/interrupt/i);
});

it("changes corpus identity when retained reference content changes without a version bump", async () => {
  const { readFileSync, writeFileSync } = await import("node:fs");
  const source = fileURLToPath(
    new URL("../../../benchmark/person-research/people/achim-steiner.json", import.meta.url),
  );
  const directory = mkdtempSync(join(tmpdir(), "benchmark-corpus-"));
  roots.push(directory);
  const path = join(directory, "person.json");
  writeFileSync(path, readFileSync(source));
  const before = loadCorpus(directory);
  const person = before.people[0];
  person.facts[0].statement = "The retained account describes Steiner's UNDP tenure as historical.";
  writeFileSync(path, JSON.stringify(person));
  const after = loadCorpus(directory);
  expect(after.rejected).toEqual([]);
  expect(after.version).not.toBe(before.version);
});

it("refuses comparisons across different people and judge providers", async () => {
  const { compareReports } = await import("../../../apps/server/src/person-benchmark/report");
  const { BenchmarkReportSchema } = await import("@chief-of-staff-demo/shared");
  const baseline = BenchmarkReportSchema.parse({
    schemaVersion: 1,
    runId: "baseline",
    status: "completed",
    statusDetail: "Fixture",
    mode: "live-discovery",
    selection: { requested: ["alice"], evaluated: ["alice"], skipped: [] },
    provenance: {
      corpusVersion: "fixed",
      referenceVersions: { alice: "2026-09-06.1" },
      pipeline: "incumbent",
      researchProvider: "openrouter",
      researchModel: "research",
      judgeProvider: "openrouter",
      judgeModel: "judge",
      judgeVersion: "1",
      promptVersion: "1",
      collectorVersions: {},
      researchSettings: {},
      network: "live",
      startedAt: "2026-09-06",
      finishedAt: "2026-09-06",
      host: "fixture",
    },
    people: [],
    groups: [],
    remainingMisses: [],
  });
  const candidate = structuredClone(baseline);
  candidate.runId = "candidate";
  candidate.selection.evaluated = ["bob"];
  candidate.provenance.referenceVersions.bob = "2026-09-06.1";
  expect(compareReports(baseline, candidate).verdict).toBe("not-comparable");
  candidate.selection.evaluated = ["alice"];
  delete candidate.provenance.referenceVersions.bob;
  candidate.provenance.judgeProvider = "ollama";
  expect(compareReports(baseline, candidate).verdict).toBe("not-comparable");
});

it("rejects ambiguous document identities instead of silently choosing one retained version", async () => {
  const { writeFileSync } = await import("node:fs");
  const person = loadCorpus(
    fileURLToPath(new URL("../../../benchmark/person-research/people", import.meta.url)),
  ).people[0];
  const directory = mkdtempSync(join(tmpdir(), "benchmark-duplicate-"));
  roots.push(directory);
  person.documents.push(structuredClone(person.documents[0]));
  writeFileSync(join(directory, "person.json"), JSON.stringify(person));
  const corpus = loadCorpus(directory);
  expect(corpus.people).toEqual([]);
  expect(corpus.rejected[0]?.reason).toMatch(/duplicate/i);
});

it.each([
  ["Maya built the entire Atlas product alone.", "team-output-as-personal"],
  ["Daniel Ortiz designed the Atlas scheduler.", "wrong-person"],
] as const)("separates quote integrity from semantic attribution: %s", async (statement, kind) => {
  const { readFileSync } = await import("node:fs");
  const { createHash } = await import("node:crypto");
  const { BenchmarkPersonSchema } = await import("@chief-of-staff-demo/shared");
  const fixture = JSON.parse(
    readFileSync(
      fileURLToPath(new URL("../../fixtures/person-dossiers/comprehensive.json", import.meta.url)),
      "utf8",
    ),
  ) as {
    url: string;
    text: string;
    extraction: { claims: { statement: string }[] };
  };
  const person = BenchmarkPersonSchema.parse({
    schemaVersion: 1,
    slug: "fictional-maya",
    referenceVersion: "2026-09-06.1",
    displayName: "Maya Chen",
    industry: "technology",
    role: "Engineer",
    region: "Fictional",
    language: "en",
    footprint: "rich",
    fictional: true,
    lookup: { fullName: "Maya Chen", employerHint: null, profileUrls: [fixture.url], emails: [] },
    identityAnchors: ["Fictional Maya Chen at example.com/maya"],
    documents: [
      {
        id: "fixture",
        url: fixture.url,
        title: "Fictional Maya Chen",
        publisher: "Fictional Northline",
        publishedAt: null,
        retrievedAt: "2026-09-06",
        family: "documents-publishers",
        sourceClass: "independent-account",
        language: "en",
        hash: createHash("sha256").update(fixture.text).digest("hex"),
        excerpt: fixture.text,
        rights: "public-domain",
      },
    ],
    facts: [
      {
        id: "contribution",
        requirements: ["r1"],
        section: "work",
        statement: "Maya designed the scheduler; the team built the UI.",
        effectiveFrom: null,
        effectiveTo: null,
        support: [
          {
            documentId: "fixture",
            quote:
              "Maya Chen designed the Atlas scheduler; the Northline team built its user interface.",
          },
        ],
        importance: "core",
        acquisition: "app-supported",
      },
    ],
  });
  person.documents.push({
    ...person.documents[0],
    id: "mirror",
    url: "https://mirror.example/maya",
  });
  fixture.extraction.claims[0].statement = statement;
  const workspaceDir = mkdtempSync(join(tmpdir(), "benchmark-semantics-"));
  roots.push(workspaceDir);
  const { result } = await evaluatePerson(person, "fixed-documents", {
    workspaceDir,
    search: async () => {
      throw new Error("Fixed documents must not contact live search");
    },
    complete: () => async () => structuredClone(fixture.extraction),
    judge: async ({ user }) => {
      if (user.includes('"references":')) return { judgements: [] };
      const input = JSON.parse(user) as { dossier: { id: string; statement: string }[] };
      const claim = input.dossier.find((entry) => entry.statement === statement)!;
      return {
        understanding: 1,
        remainingQuestions: 1,
        conversationReadiness: 1,
        rationale: "The quoted passage does not justify the asserted attribution.",
        uncertain: false,
        overclaims: [
          {
            claimId: claim.id,
            statement,
            kind,
            rationale: "The source credits Maya with the scheduler and the team with the UI.",
            matchedUnjustifiedId: null,
            uncertain: false,
          },
        ],
      };
    },
  });
  expect(result.failure).toBeNull();
  expect(result.richness.sources).toBeGreaterThan(1);
  expect(result.richness.distinctUpstreamIndexes).toBe(1);
  expect(result.factualReliability.verifiedCitations).toBeGreaterThan(0);
  expect(result.factualReliability.overclaims).toContainEqual(
    expect.objectContaining({ statement, kind }),
  );
  expect(result.completeness.recovered).toBe(0);
  const { compareReports, renderReport, summarizeGroups, remainingMisses } =
    await import("../../../apps/server/src/person-benchmark/report");
  const { BenchmarkReportSchema } = await import("@chief-of-staff-demo/shared");
  const baseline = BenchmarkReportSchema.parse({
    schemaVersion: 1,
    runId: "baseline",
    status: "completed",
    statusDetail: "Fixture",
    mode: "fixed-documents",
    selection: { requested: [person.slug], evaluated: [person.slug], skipped: [] },
    provenance: {
      corpusVersion: "fixed",
      referenceVersions: { [person.slug]: person.referenceVersion },
      pipeline: "expanded",
      researchProvider: "fixture",
      researchModel: "fixture",
      judgeProvider: "fixture",
      judgeModel: "fixture",
      judgeVersion: "1",
      promptVersion: "1",
      collectorVersions: {},
      researchSettings: {},
      network: "fixed-documents",
      startedAt: "2026-09-06",
      finishedAt: "2026-09-06",
      host: "fixture",
    },
    people: [result],
    groups: summarizeGroups([person], [result]),
    remainingMisses: remainingMisses([person], [result]),
  });
  const readable = renderReport(baseline, [person]);
  expect(readable).toContain("Remaining misses");
  expect(readable).toContain("Maya designed the scheduler");
  expect(baseline.groups).toContainEqual(
    expect.objectContaining({ dimension: "industry", people: 1, referenceFacts: 1, recovered: 0 }),
  );
  if (kind === "wrong-person") {
    const candidate = structuredClone(baseline);
    baseline.people[0].factualReliability.overclaims = [];
    baseline.people[0].factualReliability.wrongPersonAttributions = 0;
    candidate.people[0].completeness.recovered = 1;
    expect(compareReports(baseline, candidate).verdict).toBe("regressed");
  }
});
