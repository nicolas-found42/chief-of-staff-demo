import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { PersonDossierSchema, PersonSourceDocumentSchema } from "@chief-of-staff-demo/shared";
import { loadCorpus } from "../../../apps/server/src/person-benchmark/corpus.js";
import { judgePerson } from "../../../apps/server/src/person-benchmark/judge.js";

function fixture() {
  const person = loadCorpus(
    fileURLToPath(new URL("../../../benchmark/person-research/people", import.meta.url)),
  ).people[0];
  person.fictional = true;
  person.displayName = "Fictional Maya";
  person.facts = [{ ...person.facts[0], statement: "Maya designed the scheduler." }];
  const quote = `${"Context. ".repeat(100)}The team built the interface; the individual designed its scheduler.`;
  const sources = Array.from({ length: 41 }, (_, index) =>
    PersonSourceDocumentSchema.parse({
      schemaVersion: 1,
      id: `source-${index}`,
      url: `https://example.com/${index}`,
      title: `Source ${index}`,
      author: null,
      publishedAt: null,
      retrievedAt: "2026-09-06",
      text: quote,
      hash: "a".repeat(64),
      family: "fixture",
      sourceClass: "independent-account",
      visibility: "public",
      completeness: "full",
      access: "retrieved",
      acquisition: "fixture",
      outboundUrls: ["https://example.com/navigation"],
    }),
  );
  const dossier = PersonDossierSchema.parse({
    schemaVersion: 1,
    profileId: "fixture",
    revision: 1,
    updatedAt: "2026-09-06",
    sourceIds: sources.map((source) => source.id),
    works: [],
    expertise: [],
    connections: [],
    sections: [],
    claims: Array.from({ length: 121 }, (_, index) => ({
      id: `claim-${index}`,
      statement:
        index === 120
          ? "Maya designed the scheduler and built the entire interface."
          : `Other fact ${index}`,
      section: "career",
      status: "supported",
      nature: "statement",
      matchConfidence: "high",
      effectiveFrom: null,
      effectiveTo: null,
      supports: [],
      supersedes: [],
      changeReason: null,
      citations: Array.from({ length: 4 }, (_, citation) => ({
        sourceId: `source-${citation === 3 ? 40 : citation}`,
        quote: citation === 3 ? quote : "Context.",
      })),
    })),
  });
  return { person, dossier, sources, quote };
}

it("assesses recovery and overclaims beyond claim 120 with complete passages and source metadata", async () => {
  const { person, dossier, sources, quote } = fixture();
  const result = await judgePerson(
    async ({ user }) => {
      const request = JSON.parse(user) as {
        references?: unknown;
        dossier: {
          id: string;
          statement: string;
          citations: { citationIndex: number; sourceId: string; quote: string }[];
        }[];
        retainedSources?: { url: string }[];
      };
      expect(user).not.toContain("https://example.com/navigation");
      const target = request.dossier.find((claim) => claim.id === "claim-120");
      if (request.references)
        return {
          judgements: [
            {
              factId: person.facts[0].id,
              verdict: target ? "recovered" : "missing",
              evidence: target?.statement ?? null,
              claimId: target?.id ?? null,
              rationale: "Matched supplied evidence.",
            },
          ],
        };
      expect(request.retainedSources).toEqual(
        sources.map((source) =>
          PersonSourceDocumentSchema.omit({ text: true, outboundUrls: true }).parse(source),
        ),
      );
      const supportPresent =
        target?.citations.some((citation) => citation.quote === quote) &&
        request.retainedSources?.some((source) => source.url === sources[40].url);
      return {
        understanding: 1,
        remainingQuestions: 1,
        conversationReadiness: 1,
        rationale: "Checked individual contribution.",
        uncertain: false,
        overclaims:
          target && supportPresent
            ? [
                {
                  claimId: target.id,
                  citationIndex: 3,
                  statement: target.statement,
                  kind: "team-output-as-personal",
                  rationale: "The complete passage attributes the interface to the team.",
                  matchedUnjustifiedId: null,
                  uncertain: false,
                },
              ]
            : [],
      };
    },
    person,
    dossier,
    sources,
  );
  expect(result.complete).toBe(true);
  expect(result.judgements[0]).toMatchObject({ verdict: "recovered", claimId: "claim-120" });
  expect(result.overclaims).toContainEqual(
    expect.objectContaining({
      claimId: "claim-120",
      kind: "team-output-as-personal",
      citationIndex: 3,
      citedSourceId: "source-40",
      citedQuote: quote,
    }),
  );
});

it("marks a saturated overclaim response incomplete while retaining its findings", async () => {
  const { person, dossier, sources } = fixture();
  const result = await judgePerson(
    async ({ user }) =>
      user.includes('"references":')
        ? {
            judgements: [
              {
                factId: person.facts[0].id,
                verdict: "missing",
                evidence: null,
                claimId: null,
                rationale: "Not recovered.",
              },
            ],
          }
        : {
            understanding: 0,
            remainingQuestions: 0,
            conversationReadiness: 0,
            rationale: "Many unsupported assertions.",
            uncertain: false,
            overclaims: dossier.claims.slice(0, 40).map((claim) => ({
              claimId: claim.id,
              citationIndex: 0,
              statement: claim.statement,
              kind: "unsupported-inference",
              rationale: "The citation does not establish this claim.",
              matchedUnjustifiedId: null,
              uncertain: false,
            })),
          },
    person,
    dossier,
    sources,
  );
  expect(result.complete).toBe(false);
  expect(result.overclaims).toHaveLength(40);
  expect(result.incompleteReason).toContain("overclaim response limit of 40");
  expect(result.usefulness.reviewRequired).toBe(true);
  expect(result.usefulness.rationale).toContain("overclaim response limit of 40");
});

it.each([
  ["wrong-person", false],
  ["invented-evidence", false],
  ["unsupported-inference", true],
  ["none", false],
] as const)(
  "withholds recovered/partial credit from validated %s findings before aggregates",
  async (kind, uncertain) => {
    const { assessPerson } = await import("../../../apps/server/src/person-benchmark/evaluate.js");
    const { createHash } = await import("node:crypto");
    const { person, dossier, sources } = fixture();
    for (const source of sources)
      source.hash = createHash("sha256").update(source.text).digest("hex");
    for (const verdict of ["recovered", "partial"] as const) {
      const result = await assessPerson(person, "fixed-documents", {
        dossier,
        publicProjection: dossier,
        sources,
        operation: null,
        elapsedMilliseconds: 0,
        judge: async ({ user }) =>
          user.includes('"references":')
            ? {
                judgements: [
                  {
                    factId: person.facts[0].id,
                    verdict,
                    evidence: dossier.claims[120].statement,
                    claimId: "claim-120",
                    rationale: "Semantic match.",
                  },
                ],
              }
            : {
                understanding: 1,
                remainingQuestions: 1,
                conversationReadiness: 1,
                uncertain: false,
                rationale: "Reviewed support.",
                overclaims:
                  kind === "none"
                    ? []
                    : [
                        {
                          claimId: "claim-120",
                          statement: dossier.claims[120].statement,
                          citationIndex: 3,
                          kind,
                          rationale: "The selected passage does not support this attribution.",
                          matchedUnjustifiedId: null,
                          uncertain,
                        },
                      ],
              },
      });
      expect(result.assessment?.judge).toBe("completed");
      expect(result.completeness.judgements[0].verdict).toBe(
        kind === "none" ? verdict : "ambiguous",
      );
      if (kind !== "none") {
        expect(result.completeness.recovered + result.completeness.partial).toBe(0);
        expect(result.completeness.judgements[0]).toMatchObject({
          reviewRequired: true,
          rationale: expect.stringContaining(`Original semantic verdict: ${verdict}`),
        });
        expect(
          Object.values(result.completeness.byRequirement).every((row) => row.recovered === 0),
        ).toBe(true);
        expect(result.sourceContributions?.every((row) => row.recoveredFactIds.length === 0)).toBe(
          true,
        );
      }
    }
  },
);

it.each(["wrong-index", "null-with-citations", "null-without-citations"] as const)(
  "validates the selected citation against its own claim: %s",
  async (kind) => {
    const { person, dossier, sources } = fixture();
    if (kind === "null-without-citations") dossier.claims[120].citations = [];
    const result = await judgePerson(
      async ({ user }) =>
        user.includes('"references":')
          ? {
              judgements: [
                {
                  factId: person.facts[0].id,
                  verdict: "missing",
                  evidence: null,
                  claimId: null,
                  rationale: "Missing.",
                },
              ],
            }
          : {
              understanding: 1,
              remainingQuestions: 1,
              conversationReadiness: 1,
              uncertain: false,
              rationale: "Reviewed support.",
              overclaims: [
                {
                  claimId: "claim-120",
                  statement: dossier.claims[120].statement,
                  citationIndex: kind === "wrong-index" ? 29 : null,
                  kind: "invented-evidence",
                  rationale: "Fixture finding.",
                  matchedUnjustifiedId: null,
                  uncertain: false,
                },
              ],
            },
      person,
      dossier,
      sources,
    );
    expect(result.complete).toBe(kind === "null-without-citations");
    if (kind === "null-without-citations")
      expect(result.overclaims[0]).toMatchObject({
        citationIndex: null,
        citedSourceId: null,
        citedQuote: null,
      });
    else {
      expect(result.overclaims).toEqual([]);
      expect(result.phases.support).toMatchObject({
        status: "failed",
        unresolvedFindings: [
          expect.objectContaining({ claimId: "claim-120", citedSourceId: null, citedQuote: null }),
        ],
      });
    }
  },
);
