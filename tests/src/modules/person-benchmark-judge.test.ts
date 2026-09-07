import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { PersonDossierSchema, PersonSourceDocumentSchema } from "@chief-of-staff-demo/shared";
import type {
  BenchmarkPerson,
  PersonDossier,
  PersonSourceDocument,
} from "@chief-of-staff-demo/shared";
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

const SUPPORT_OK = {
  understanding: 1,
  remainingQuestions: 1,
  conversationReadiness: 1,
  uncertain: false,
  rationale: "Reviewed support.",
  overclaims: [],
};

it("credits a verdict that selects its claim by a verbatim claim excerpt", async () => {
  const { person, dossier, sources } = fixture();
  const result = await judgePerson(
    async ({ user }) =>
      user.includes('"references":')
        ? {
            judgements: [
              {
                factId: person.facts[0].id,
                verdict: "recovered",
                evidence: dossier.claims[120].statement,
                claimId: "claim-120",
                rationale: "The dossier states the same fact.",
              },
            ],
          }
        : SUPPORT_OK,
    person,
    dossier,
    sources,
  );
  expect(result.judgements[0]).toMatchObject({ verdict: "recovered", claimId: "claim-120" });
  expect(result.judgements[0].rationale).not.toContain("does not occur in the dossier");
  expect(result.judgements[0].reviewRequired).toBe(false);
});

it("rejects a citation-passage selection as an unresolved observation", async () => {
  const { person, dossier, sources, quote } = fixture();
  const result = await judgePerson(
    async ({ user }) =>
      user.includes('"references":')
        ? {
            judgements: [
              {
                factId: person.facts[0].id,
                verdict: "recovered",
                evidence: quote,
                claimId: "claim-120",
                rationale: "The dossier states the same fact.",
              },
            ],
          }
        : SUPPORT_OK,
    person,
    dossier,
    sources,
  );
  expect(result.judgements[0].verdict).toBe("ambiguous");
  expect(result.judgements[0].reviewRequired).toBe(true);
  expect(result.judgements[0].rationale).toContain("does not occur in the dossier");
  expect(result.judgements[0].rationale).toContain("cited passage, not the claim statement");
});

it("recognizes a citation-passage selection despite formatting differences", async () => {
  const { person, dossier, sources, quote } = fixture();
  const wrapped = quote.replace("built the interface;", "built the\ninterface;");
  const result = await judgePerson(
    async ({ user }) =>
      user.includes('"references":')
        ? {
            judgements: [
              {
                factId: person.facts[0].id,
                verdict: "recovered",
                evidence: wrapped,
                claimId: "claim-120",
                rationale: "The dossier states the same fact.",
              },
            ],
          }
        : SUPPORT_OK,
    person,
    dossier,
    sources,
  );
  expect(result.judgements[0].verdict).toBe("ambiguous");
  expect(result.judgements[0].rationale).toContain("does not occur in the dossier");
  expect(result.judgements[0].rationale).toContain("cited passage, not the claim statement");
});

it("rejects an invented excerpt as an unresolved observation", async () => {
  const { person, dossier, sources } = fixture();
  const result = await judgePerson(
    async ({ user }) =>
      user.includes('"references":')
        ? {
            judgements: [
              {
                factId: person.facts[0].id,
                verdict: "recovered",
                evidence: "Maya single-handedly invented the scheduler in 1999.",
                claimId: "claim-120",
                rationale: "The dossier states the same fact.",
              },
            ],
          }
        : SUPPORT_OK,
    person,
    dossier,
    sources,
  );
  expect(result.judgements[0].verdict).toBe("ambiguous");
  expect(result.judgements[0].reviewRequired).toBe(true);
  expect(result.judgements[0].rationale).toContain("does not occur in the dossier");
  expect(result.judgements[0].rationale).not.toContain("cited passage, not the claim statement");
});

it("shows the recovery judge claim statements without cited passages", async () => {
  const { person, dossier, sources } = fixture();
  const captured: { dossier: unknown[] | null } = { dossier: null };
  await judgePerson(
    async ({ user }) => {
      const request = JSON.parse(user) as { references?: unknown; dossier: unknown[] };
      if (request.references) {
        captured.dossier = request.dossier;
        return {
          judgements: [
            {
              factId: person.facts[0].id,
              verdict: "missing",
              evidence: null,
              claimId: null,
              rationale: "Not recovered.",
            },
          ],
        };
      }
      return SUPPORT_OK;
    },
    person,
    dossier,
    sources,
  );
  expect(captured.dossier).toHaveLength(dossier.claims.length);
  for (const entry of captured.dossier ?? []) {
    expect(entry).not.toHaveProperty("citations");
    expect(JSON.stringify(entry)).not.toContain("Context.");
  }
});

/* Issue #236: paraphrase and cross-language matches receive decided verdicts.
 *
 * The contract has a deterministic half and a model half, and only the first
 * is reachable from here. These tests pin the recovery prompt's contract and
 * the guard's treatment of each verdict shape: that a decided paraphrase
 * survives, that a cross-language excerpt is credited while citation
 * integrity stays exact, that a rejection carries the claim it rejected, and
 * that the judge's own ambiguity is preserved as itself.
 *
 * Whether the model actually decides a paraphrase it could have parked is not
 * a unit test — it needs a live call, which spends provider budget and has no
 * credential in CI, so it belongs in a prompt eval rather than in `check`.
 * That measurement is issue #270, against a population whose dossiers carry
 * claims; the run recorded on the pull request is its first data point.
 */

/**
 * One reference fact, one dossier claim, one cited passage. The wording of
 * each is the variable under test, so a paraphrase, a translation and an
 * unsupported broadening differ only in the strings supplied here.
 */
function semanticFixture(options: { reference: string; claim: string; passage: string }): {
  person: BenchmarkPerson;
  factId: string;
  dossier: PersonDossier;
  sources: PersonSourceDocument[];
} {
  const person = loadCorpus(
    fileURLToPath(new URL("../../../benchmark/person-research/people", import.meta.url)),
  ).people[0];
  person.fictional = true;
  person.displayName = "Fictional Maya";
  const factId = person.facts[0].id;
  person.facts = [{ ...person.facts[0], statement: options.reference }];
  const sources = [
    PersonSourceDocumentSchema.parse({
      schemaVersion: 1,
      id: "source-0",
      url: "https://example.com/0",
      title: "Source 0",
      author: null,
      publishedAt: null,
      retrievedAt: "2026-09-06",
      text: `Context. ${options.passage}`,
      hash: "b".repeat(64),
      family: "fixture",
      sourceClass: "independent-account",
      visibility: "public",
      completeness: "full",
      access: "retrieved",
      acquisition: "fixture",
      outboundUrls: [],
    }),
  ];
  const dossier = PersonDossierSchema.parse({
    schemaVersion: 1,
    profileId: "semantic-fixture",
    revision: 1,
    updatedAt: "2026-09-06",
    sourceIds: ["source-0"],
    works: [],
    expertise: [],
    connections: [],
    sections: [],
    claims: [
      {
        id: "claim-semantic",
        statement: options.claim,
        section: "career",
        status: "supported",
        nature: "statement",
        matchConfidence: "high",
        effectiveFrom: null,
        effectiveTo: null,
        supports: [],
        supersedes: [],
        changeReason: null,
        citations: [{ sourceId: "source-0", quote: options.passage }],
      },
    ],
  });
  return { person, factId, dossier, sources };
}

it("states the meaning contract to the recovery judge", async () => {
  const { person, factId, dossier, sources } = semanticFixture({
    reference: "Maya designed the scheduler in 2021.",
    claim: "In 2021 Maya created the scheduling component.",
    passage: "Colleagues confirm Maya created the scheduling component in 2021.",
  });
  let recoverySystem = "";
  await judgePerson(
    async ({ system, user }) => {
      if (!user.includes('"references":')) return SUPPORT_OK;
      recoverySystem = system;
      return {
        judgements: [
          { factId, verdict: "missing", evidence: null, claimId: null, rationale: "Not stated." },
        ],
      };
    },
    person,
    dossier,
    sources,
  );
  /* Paraphrase and translation are decidable; scope, subject and dates are
     what a paraphrase has to preserve; ambiguous is for evidence that does
     not settle the question, not for wording the judge has to work at. */
  expect(recoverySystem).toContain("same scope, subject and dates");
  expect(recoverySystem).toContain("different language");
  expect(recoverySystem).toContain("broadens");
  expect(recoverySystem).toContain("genuinely does not settle");
});

it("credits a paraphrase that preserves scope, subject and dates", async () => {
  const claim = "In 2021 Maya created the scheduling component.";
  const { person, factId, dossier, sources } = semanticFixture({
    reference: "Maya designed the scheduler in 2021.",
    claim,
    passage: "Colleagues confirm Maya created the scheduling component in 2021.",
  });
  const result = await judgePerson(
    async ({ user }) =>
      user.includes('"references":')
        ? {
            judgements: [
              {
                factId,
                verdict: "recovered",
                evidence: claim,
                claimId: "claim-semantic",
                rationale: "The dossier restates the fact with the same scope, subject and dates.",
              },
            ],
          }
        : SUPPORT_OK,
    person,
    dossier,
    sources,
  );
  expect(result.judgements[0]).toMatchObject({
    verdict: "recovered",
    claimId: "claim-semantic",
    evidenceQuote: claim,
    reviewRequired: false,
  });
  expect(result.judgements[0].rationale).not.toContain("Downgraded");
});

it("judges a claim written in another language than its citation on meaning", async () => {
  /* The claim is Swedish, its cited passage Swedish, the reference English:
     the language gap is the designed property the collection carries, not a
     reason to withhold a verdict. */
  const claim = "Danielsson tillträdde som verkställande direktör för Skanska den 1 januari 2018.";
  const { person, factId, dossier, sources } = semanticFixture({
    reference: "Anders Danielsson took office as chief executive of Skanska on 1 January 2018.",
    claim,
    passage: `Enligt bolaget: ${claim}`,
  });
  const result = await judgePerson(
    async ({ user }) =>
      user.includes('"references":')
        ? {
            judgements: [
              {
                factId,
                verdict: "recovered",
                evidence: claim,
                claimId: "claim-semantic",
                rationale: "The Swedish claim states the English reference fact.",
              },
            ],
          }
        : SUPPORT_OK,
    person,
    dossier,
    sources,
  );
  expect(result.judgements[0]).toMatchObject({
    verdict: "recovered",
    claimId: "claim-semantic",
    evidenceQuote: claim,
    reviewRequired: false,
  });
  /* Citation integrity is untouched by the language gap: the cited passage
     still has to occur verbatim in the retained source. */
  const { checkIntegrity } = await import("../../../apps/server/src/person-benchmark/integrity.js");
  expect(checkIntegrity(dossier, sources, dossier).findings).toEqual([]);
});

it("keeps the excerpt contract for a cross-language citation-passage selection", async () => {
  const claim = "Danielsson tillträdde som verkställande direktör för Skanska den 1 januari 2018.";
  const passage = `Enligt bolaget: ${claim}`;
  const { person, factId, dossier, sources } = semanticFixture({
    reference: "Anders Danielsson took office as chief executive of Skanska on 1 January 2018.",
    claim,
    passage,
  });
  const result = await judgePerson(
    async ({ user }) =>
      user.includes('"references":')
        ? {
            judgements: [
              {
                factId,
                verdict: "recovered",
                evidence: passage,
                claimId: "claim-semantic",
                rationale: "The dossier states the same fact.",
              },
            ],
          }
        : SUPPORT_OK,
    person,
    dossier,
    sources,
  );
  expect(result.judgements[0].verdict).toBe("ambiguous");
  expect(result.judgements[0].rationale).toContain("cited passage, not the claim statement");
});

it("rejects an unsupported broadening and records the claim it rejected", async () => {
  const claim = "Maya led European operations for several years.";
  const { person, factId, dossier, sources } = semanticFixture({
    reference: "Maya led the Berlin office from 2019 to 2021.",
    claim,
    passage: "Maya led European operations for several years, the profile says.",
  });
  const result = await judgePerson(
    async ({ user }) =>
      user.includes('"references":')
        ? {
            judgements: [
              {
                factId,
                verdict: "missing",
                evidence: claim,
                claimId: "claim-semantic",
                rationale: "The dossier widens the Berlin office to European operations.",
              },
            ],
          }
        : SUPPORT_OK,
    person,
    dossier,
    sources,
  );
  expect(result.judgements[0]).toMatchObject({
    verdict: "missing",
    claimId: "claim-semantic",
    evidenceQuote: claim,
    reviewRequired: false,
  });
  expect(result.judgements[0].rationale).not.toContain("Downgraded");
});

it("withholds a rejection that names a claim it never quoted", async () => {
  const { person, factId, dossier, sources } = semanticFixture({
    reference: "Maya led the Berlin office from 2019 to 2021.",
    claim: "Maya led European operations for several years.",
    passage: "Maya led European operations for several years, the profile says.",
  });
  const result = await judgePerson(
    async ({ user }) =>
      user.includes('"references":')
        ? {
            judgements: [
              {
                factId,
                verdict: "missing",
                evidence: null,
                claimId: "claim-semantic",
                rationale: "The dossier claims something broader.",
              },
            ],
          }
        : SUPPORT_OK,
    person,
    dossier,
    sources,
  );
  expect(result.judgements[0].verdict).toBe("ambiguous");
  expect(result.judgements[0].reviewRequired).toBe(true);
  expect(result.judgements[0].rationale).toContain("quotes no dossier text");
});

it("leaves a fact no claim addresses missing without inventing evidence", async () => {
  const { person, factId, dossier, sources } = semanticFixture({
    reference: "Maya led the Berlin office from 2019 to 2021.",
    claim: "Maya spoke at a conference in Lisbon.",
    passage: "Maya spoke at a conference in Lisbon.",
  });
  const result = await judgePerson(
    async ({ user }) =>
      user.includes('"references":')
        ? {
            judgements: [
              {
                factId,
                verdict: "missing",
                evidence: null,
                claimId: null,
                rationale: "No claim addresses the Berlin office.",
              },
            ],
          }
        : SUPPORT_OK,
    person,
    dossier,
    sources,
  );
  expect(result.judgements[0]).toMatchObject({
    verdict: "missing",
    claimId: null,
    evidenceQuote: null,
    reviewRequired: false,
  });
});

it("leaves a genuinely undetermined match for review rather than guessing", async () => {
  const claim = "Maya worked on scheduling around that time.";
  const { person, factId, dossier, sources } = semanticFixture({
    reference: "Maya designed the scheduler in 2021.",
    claim,
    passage: "Maya worked on scheduling around that time, colleagues recall.",
  });
  const result = await judgePerson(
    async ({ user }) =>
      user.includes('"references":')
        ? {
            judgements: [
              {
                factId,
                verdict: "ambiguous",
                evidence: claim,
                claimId: "claim-semantic",
                rationale: "The wording does not settle whether the scheduler is the same work.",
              },
            ],
          }
        : SUPPORT_OK,
    person,
    dossier,
    sources,
  );
  expect(result.judgements[0]).toMatchObject({
    verdict: "ambiguous",
    claimId: "claim-semantic",
    evidenceQuote: claim,
    reviewRequired: true,
  });
  /* The judge's own ambiguity is preserved as itself: no downgrade marker,
     so the ambiguity classifier attributes it to semantic judgement. */
  expect(result.judgements[0].rationale).not.toContain("Downgraded");
});

it.each(["", "   "])(
  "reads a blank claim id (%j) as naming no claim rather than as an unquoted rejection",
  async (blank) => {
    /* RecoverySchema permits a blank id, so the guard has to decide what one
       means. It names no claim: the fact is simply missing, and recording the
       blank would put a claim in the report that nothing resolves. */
    const { person, factId, dossier, sources } = semanticFixture({
      reference: "Maya led the Berlin office from 2019 to 2021.",
      claim: "Maya spoke at a conference in Lisbon.",
      passage: "Maya spoke at a conference in Lisbon.",
    });
    const result = await judgePerson(
      async ({ user }) =>
        user.includes('"references":')
          ? {
              judgements: [
                {
                  factId,
                  verdict: "missing",
                  evidence: null,
                  claimId: blank,
                  rationale: "No claim addresses the Berlin office.",
                },
              ],
            }
          : SUPPORT_OK,
      person,
      dossier,
      sources,
    );
    expect(result.judgements[0]).toMatchObject({
      verdict: "missing",
      claimId: null,
      evidenceQuote: null,
      reviewRequired: false,
    });
    expect(result.judgements[0].rationale).not.toContain("Downgraded");
  },
);
