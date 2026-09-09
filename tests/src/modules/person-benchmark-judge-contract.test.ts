import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { PersonDossierSchema } from "@chief-of-staff-demo/shared";
import type { PersonSourceDocument } from "@chief-of-staff-demo/shared";
import { loadCorpus } from "../../../apps/server/src/person-benchmark/corpus.js";
import { assessPerson } from "../../../apps/server/src/person-benchmark/evaluate.js";
import {
  CURRENT_CONTRACT,
  PRE236_CONTRACT,
  judgePerson,
} from "../../../apps/server/src/person-benchmark/judge.js";
import type { CompleteJson } from "../../../apps/server/src/llm/providers.js";

/**
 * The issue-#270 measurement seam: the differential re-judges one retained
 * population under the current contract and under the pre-#236 contract, so
 * the reduction the paraphrase/cross-language contract owns is measured
 * rather than inferred. These tests pin the seam, not the model: every live
 * call the differential makes goes through the stubbed shape below.
 */
function contractFixture() {
  const person = loadCorpus(
    fileURLToPath(new URL("../../../benchmark/person-research/people", import.meta.url)),
  ).people[0];
  person.fictional = true;
  person.displayName = "Fictional Maya";
  person.facts = [{ ...person.facts[0], statement: "Maya designed the scheduler." }];
  const dossier = PersonDossierSchema.parse({
    schemaVersion: 1,
    profileId: "fixture",
    revision: 1,
    updatedAt: "2026-09-06",
    sourceIds: [],
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
        citations: [],
      },
    ],
  });
  return { person, dossier, sources: [] as PersonSourceDocument[] };
}

const emptySupportReply = {
  understanding: 1,
  remainingQuestions: 1,
  conversationReadiness: 1,
  rationale: "Checked.",
  uncertain: false,
  overclaims: [],
};

function stubComplete(
  recoveryJudgement: Record<string, unknown>,
  onSystem?: (system: string) => void,
): CompleteJson {
  return async (request) => {
    const isRecovery = JSON.parse(request.user)["references"] !== undefined;
    if (isRecovery) onSystem?.(request.system);
    if (isRecovery) return recoveryJudgement;
    return emptySupportReply;
  };
}

it("sends the current meaning contract by default and the legacy prompt under the pre-#236 contract", async () => {
  const { person, dossier, sources } = contractFixture();
  const missing = {
    judgements: [
      {
        factId: person.facts[0].id,
        verdict: "missing",
        evidence: null,
        claimId: null,
        rationale: "No dossier claim addresses the fact.",
      },
    ],
  };
  const systems: string[] = [];
  await judgePerson(
    stubComplete(missing, (system) => systems.push(system)),
    person,
    dossier,
    sources,
  );
  await judgePerson(
    stubComplete(missing, (system) => systems.push(system)),
    person,
    dossier,
    sources,
    PRE236_CONTRACT,
  );
  expect(systems).toHaveLength(2);
  expect(systems[0]).toContain("Judge meaning, not wording");
  expect(systems[1]).toContain("paraphrase included");
  expect(systems[1]).not.toContain("Judge meaning, not wording");
  expect(CURRENT_CONTRACT.recoverySystem).toBe(systems[0]);
  expect(PRE236_CONTRACT.recoverySystem).toBe(systems[1]);
});

it("parks a missing verdict that names a claim without quoting it, except under the pre-#236 contract", async () => {
  // The exact-claim guard parks an unquoted `recovered` verdict under both
  // contracts; the #236 rule additionally parks a `missing` verdict that
  // names a claim, since crediting and rejecting must both be checkable.
  const { person, dossier, sources } = contractFixture();
  const namedWithoutQuote = {
    judgements: [
      {
        factId: person.facts[0].id,
        verdict: "missing",
        evidence: null,
        claimId: "claim-0",
        rationale: "No dossier claim addresses the fact.",
      },
    ],
  };
  const current = await judgePerson(stubComplete(namedWithoutQuote), person, dossier, sources);
  expect(current.judgements[0]).toMatchObject({
    verdict: "ambiguous",
    claimId: "claim-0",
  });
  expect(current.judgements[0]?.rationale).toContain("quotes no dossier text");
  const legacy = await judgePerson(
    stubComplete(namedWithoutQuote),
    person,
    dossier,
    sources,
    PRE236_CONTRACT,
  );
  expect(legacy.judgements[0]).toMatchObject({ verdict: "missing", claimId: "claim-0" });
});

it("treats a blank claim id as naming no claim, except under the pre-#236 contract", async () => {
  const { person, dossier, sources } = contractFixture();
  const blankClaim = {
    judgements: [
      {
        factId: person.facts[0].id,
        verdict: "missing",
        evidence: null,
        claimId: "   ",
        rationale: "No dossier claim addresses the fact.",
      },
    ],
  };
  const current = await judgePerson(stubComplete(blankClaim), person, dossier, sources);
  expect(current.judgements[0]).toMatchObject({ verdict: "missing", claimId: null });
  const legacy = await judgePerson(
    stubComplete(blankClaim),
    person,
    dossier,
    sources,
    PRE236_CONTRACT,
  );
  expect(legacy.judgements[0]).toMatchObject({ verdict: "missing", claimId: "   " });
});

it("keeps the recovery verdicts when the support call throws", async () => {
  const { person, dossier, sources } = contractFixture();
  const recovered = {
    judgements: [
      {
        factId: person.facts[0].id,
        verdict: "recovered",
        evidence: "Maya designed the scheduler.",
        claimId: "claim-0",
        rationale: "The claim states the fact verbatim.",
      },
    ],
  };
  const complete = (async (request: { user: string }) => {
    if (JSON.parse(request.user)["references"] !== undefined) return recovered;
    throw new Error("support not assessed");
  }) as CompleteJson;
  const result = await judgePerson(complete, person, dossier, sources);
  expect(result.complete).toBe(false);
  expect(result.phases.support.status).toBe("failed");
  expect(result.judgements[0]).toMatchObject({ verdict: "recovered", claimId: "claim-0" });
});

it("threads the contract through the person assessment", async () => {
  const { person, dossier, sources } = contractFixture();
  const missing = {
    judgements: [
      {
        factId: person.facts[0].id,
        verdict: "missing",
        evidence: null,
        claimId: null,
        rationale: "No dossier claim addresses the fact.",
      },
    ],
  };
  const systems: string[] = [];
  const result = await assessPerson(
    person,
    "fixed-documents",
    {
      dossier,
      sources,
      publicProjection: dossier,
      operation: null,
      judge: stubComplete(missing, (system) => systems.push(system)),
      elapsedMilliseconds: 0,
    },
    PRE236_CONTRACT,
  );
  expect(systems[0]).toContain("paraphrase included");
  expect(result.completeness.judgements[0]).toMatchObject({ verdict: "missing" });
});
