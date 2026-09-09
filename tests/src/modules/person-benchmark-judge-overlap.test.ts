import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { PersonDossierSchema, PersonSourceDocumentSchema } from "@chief-of-staff-demo/shared";
import { loadCorpus } from "../../../apps/server/src/person-benchmark/corpus.js";
import { judgePerson } from "../../../apps/server/src/person-benchmark/judge.js";

/* Overlap regression cover for the concurrent recovery/support replies: the
   two judgeReply calls are issued together and settled with Promise.all, so
   these tests pin the overlap itself plus the unchanged per-phase behavior. */
function fixture() {
  const person = loadCorpus(
    fileURLToPath(new URL("../../../benchmark/person-research/people", import.meta.url)),
  ).people[0];
  person.fictional = true;
  person.displayName = "Fictional Maya";
  person.facts = [{ ...person.facts[0], statement: "Maya designed the scheduler." }];
  const quote = "The individual designed its scheduler; the team built the interface.";
  const sources = Array.from({ length: 2 }, (_, index) =>
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
    claims: [
      {
        id: "claim-0",
        statement: "Maya designed the scheduler.",
        section: "career",
        status: "supported",
        nature: "statement",
        matchConfidence: "high",
        effectiveFrom: null,
        effectiveTo: null,
        supports: [],
        supersedes: [],
        changeReason: null,
        citations: [{ sourceId: "source-0", quote }],
      },
      {
        id: "claim-1",
        statement: "Maya advises the board.",
        section: "career",
        status: "supported",
        nature: "statement",
        matchConfidence: "high",
        effectiveFrom: null,
        effectiveTo: null,
        supports: [],
        supersedes: [],
        changeReason: null,
        citations: [{ sourceId: "source-1", quote: "Maya advises the board." }],
      },
    ],
  });
  return { person, dossier, sources, quote };
}

const SUPPORT_OK = {
  understanding: 1,
  remainingQuestions: 1,
  conversationReadiness: 1,
  uncertain: false,
  rationale: "Reviewed support.",
  overclaims: [],
};

function recoveryMissing(factId: string) {
  return {
    judgements: [
      {
        factId,
        verdict: "missing",
        evidence: null,
        claimId: null,
        rationale: "No dossier claim states it.",
      },
    ],
  };
}

it("issues the support call before the recovery call resolves", async () => {
  const { person, dossier, sources } = fixture();
  let resolveRecovery!: (value: unknown) => void;
  const recoveryGate = new Promise<unknown>((resolve) => {
    resolveRecovery = resolve;
  });
  let recoveryCalls = 0;
  let supportCalls = 0;
  const pending = judgePerson(
    async ({ user }) => {
      const request = JSON.parse(user) as { references?: unknown };
      if (request.references) {
        recoveryCalls += 1;
        return recoveryGate.then(() => recoveryMissing(person.facts[0].id));
      }
      supportCalls += 1;
      return SUPPORT_OK;
    },
    person,
    dossier,
    sources,
  );
  /* Both replies are requested before either settles: the support call is
     already issued while the recovery reply is still behind its gate. A
     sequential judge would leave supportCalls at zero here. */
  expect(recoveryCalls).toBe(1);
  expect(supportCalls).toBe(1);
  resolveRecovery(null);
  const result = await pending;
  expect(result.complete).toBe(true);
  expect(result.judgements).toHaveLength(1);
});

it("matches the sequential assessment shape when both phases succeed", async () => {
  const { person, dossier, sources } = fixture();
  let calls = 0;
  let recoveryUser = "";
  let supportUser = "";
  const result = await judgePerson(
    async ({ user }) => {
      calls += 1;
      const request = JSON.parse(user) as { references?: unknown };
      if (request.references) {
        recoveryUser = user;
        return recoveryMissing(person.facts[0].id);
      }
      supportUser = user;
      return SUPPORT_OK;
    },
    person,
    dossier,
    sources,
  );
  /* One attempt per phase, exactly as the sequential judge issues when both
     first replies are usable. */
  expect(calls).toBe(2);
  expect(result.complete).toBe(true);
  expect(result.incompleteReason).toBeNull();
  expect(result.judgements).toEqual([
    {
      factId: person.facts[0].id,
      verdict: "missing",
      referenceQuote: person.facts[0].support[0]?.quote ?? person.facts[0].statement,
      evidenceQuote: null,
      claimId: null,
      rationale: "No dossier claim states it.",
      reviewRequired: false,
    },
  ]);
  expect(result.phases).toMatchObject({
    reference: { status: "completed", failure: null },
    support: { status: "completed", failure: null },
  });
  expect(result.overclaims).toEqual([]);
  expect(result.usefulness).toMatchObject({
    understanding: 1,
    remainingQuestions: 1,
    conversationReadiness: 1,
    rationale: "Reviewed support.",
    reviewRequired: false,
  });
  /* The input split is unchanged: recovery sees statement text only while
     support sees the citations it judges. */
  const recoveryPayload = JSON.parse(recoveryUser) as {
    person: string;
    dossier: Record<string, unknown>[];
  };
  expect(recoveryPayload.person).toBe("Fictional Maya");
  expect(recoveryPayload.dossier).toEqual([
    {
      id: "claim-0",
      statement: "Maya designed the scheduler.",
      status: "supported",
      section: "career",
      effectiveFrom: null,
    },
    {
      id: "claim-1",
      statement: "Maya advises the board.",
      status: "supported",
      section: "career",
      effectiveFrom: null,
    },
  ]);
  const supportPayload = JSON.parse(supportUser) as {
    dossier: { id: string; citations: { citationIndex: number; sourceId: string }[] }[];
  };
  expect(supportPayload.dossier[0]).toMatchObject({
    id: "claim-0",
    citations: [{ citationIndex: 0, sourceId: "source-0" }],
  });
});

it("still runs the support correction retry after a rejection", async () => {
  const { person, dossier, sources } = fixture();
  let recoveryCalls = 0;
  let supportCalls = 0;
  const result = await judgePerson(
    async ({ user }) => {
      const request = JSON.parse(user) as { references?: unknown; rejectedReply?: string };
      if (request.references) {
        recoveryCalls += 1;
        return recoveryMissing(person.facts[0].id);
      }
      supportCalls += 1;
      if (supportCalls === 1) {
        expect(request.rejectedReply).toBeUndefined();
        return {
          ...SUPPORT_OK,
          overclaims: [
            {
              claimId: "claim-does-not-exist",
              citationIndex: null,
              statement: "Maya designed the scheduler.",
              kind: "team-output-as-personal",
              rationale: "Names a claim the dossier does not carry.",
              matchedUnjustifiedId: null,
              uncertain: false,
            },
          ],
        };
      }
      expect(request.rejectedReply).toContain("unknown claims");
      return SUPPORT_OK;
    },
    person,
    dossier,
    sources,
  );
  expect(recoveryCalls).toBe(1);
  expect(supportCalls).toBe(2);
  expect(result.complete).toBe(true);
  expect(result.phases.support.status).toBe("completed");
  expect(result.overclaims).toEqual([]);
});

it("keeps the failed support phase text and withholds its findings", async () => {
  const { person, dossier, sources } = fixture();
  const invalid = {
    ...SUPPORT_OK,
    overclaims: [
      {
        claimId: "claim-does-not-exist",
        citationIndex: null,
        statement: "Maya designed the scheduler.",
        kind: "team-output-as-personal",
        rationale: "Names a claim the dossier does not carry.",
        matchedUnjustifiedId: null,
        uncertain: false,
      },
    ],
  };
  let supportCalls = 0;
  const result = await judgePerson(
    async ({ user }) => {
      const request = JSON.parse(user) as { references?: unknown };
      if (request.references) return recoveryMissing(person.facts[0].id);
      supportCalls += 1;
      return invalid;
    },
    person,
    dossier,
    sources,
  );
  expect(supportCalls).toBe(2);
  expect(result.complete).toBe(false);
  expect(result.phases.support.status).toBe("failed");
  expect(result.phases.support.failure).toContain("unknown claims");
  expect(result.phases.support.unresolvedFindings).toHaveLength(1);
  expect(result.overclaims).toEqual([]);
  /* A twice-invalid reply still parses, so its scores stand while the
     rejection is prepended and the findings are withheld from overclaims. */
  expect(result.usefulness).toMatchObject({
    understanding: 1,
    remainingQuestions: 1,
    conversationReadiness: 1,
    reviewRequired: true,
  });
  expect(result.usefulness.rationale).toContain("unknown claims");
  /* The recovery verdicts stand alongside the failed support phase. */
  expect(result.judgements).toHaveLength(1);
});

it("withholds every verdict when both support attempts throw", async () => {
  const { person, dossier, sources } = fixture();
  let supportCalls = 0;
  const result = await judgePerson(
    async ({ user }) => {
      const request = JSON.parse(user) as { references?: unknown };
      if (request.references) return recoveryMissing(person.facts[0].id);
      supportCalls += 1;
      throw new Error("Controlled support outage");
    },
    person,
    dossier,
    sources,
  );
  expect(supportCalls).toBe(2);
  expect(result.complete).toBe(false);
  expect(result.phases.support.status).toBe("failed");
  expect(result.phases.support.failure).toContain(
    "Judge support/usefulness assessment failed: Controlled support outage",
  );
  expect(result.overclaims).toEqual([]);
  expect(result.usefulness).toMatchObject({
    understanding: 0,
    remainingQuestions: 0,
    conversationReadiness: 0,
    reviewRequired: true,
  });
  expect(result.usefulness.rationale).toContain("Not assessed.");
  /* The recovery verdicts stand alongside the failed support phase. */
  expect(result.judgements).toHaveLength(1);
});

it("throws the unchanged recovery failure when recovery is unusable twice", async () => {
  const { person, dossier, sources } = fixture();
  let supportCalls = 0;
  await expect(
    judgePerson(
      async ({ user }) => {
        const request = JSON.parse(user) as { references?: unknown };
        if (request.references) throw new Error("Controlled recovery outage");
        supportCalls += 1;
        return SUPPORT_OK;
      },
      person,
      dossier,
      sources,
    ),
  ).rejects.toThrow("Controlled recovery outage");
  /* Overlap issues the support call even though the recovery failure
     discards it; the thrown text is byte-identical to the sequential judge. */
  expect(supportCalls).toBe(1);
});
