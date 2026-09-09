import { expect, it } from "vitest";
import { fromPartial } from "@total-typescript/shoehorn";
import type { BenchmarkJudgement, BenchmarkPersonResult } from "@chief-of-staff-demo/shared";
import { summarizeAssignments } from "../../../apps/server/src/person-benchmark/ambiguity.js";
import {
  classifyArm,
  countArm,
  diffArms,
  renderContractDifferentialMarkdown,
  type ContractArm,
} from "../../../apps/server/src/person-benchmark/contract-differential.js";
function judgement(
  factId: string,
  verdict: BenchmarkJudgement["verdict"],
  extra: Partial<BenchmarkJudgement> = {},
): BenchmarkJudgement {
  return {
    factId,
    verdict,
    referenceQuote: `Reference ${factId}.`,
    evidenceQuote: null,
    claimId: null,
    rationale: "Fixture verdict.",
    reviewRequired: verdict === "ambiguous",
    ...extra,
  };
}

function personResult(
  slug: string,
  judgements: BenchmarkJudgement[],
  extra: Record<string, unknown> = {},
): BenchmarkPersonResult {
  return fromPartial<BenchmarkPersonResult>({
    slug,
    richness: { claims: 2 },
    assessment: {
      operationId: "op-1",
      integrity: "completed",
      judge: "completed",
      phases: {
        reference: { status: "completed", judgements: [], failure: null },
        support: { status: "completed", failure: null },
      },
    },
    factualReliability: { overclaims: [], integrityFindings: [] },
    completeness: {
      referenceFacts: judgements.length,
      judgements,
    },
    ...extra,
  });
}

function arm(label: string, people: BenchmarkPersonResult[]): ContractArm {
  return {
    label,
    contract: `${label}-contract`,
    recoveryPromptSha256: `${label}-prompt-sha`,
    people,
  };
}

it("counts verdicts and names people with failed phases", () => {
  const counts = countArm(
    arm("before", [
      personResult("maya", [
        judgement("f1", "recovered"),
        judgement("f2", "ambiguous"),
        judgement("f3", "missing"),
      ]),
      personResult("leo", [judgement("f1", "ambiguous")], {
        assessment: {
          operationId: "op-2",
          integrity: "completed",
          judge: "failed",
          phases: {
            reference: { status: "completed", judgements: [], failure: null },
            support: { status: "failed", failure: "Judge support/usefulness assessment failed." },
          },
        },
      }),
    ]),
  );
  expect(counts).toMatchObject({
    people: 2,
    facts: 4,
    recovered: 1,
    missing: 1,
    ambiguous: 2,
    ambiguousSupportAssessmentFailed: 0,
    supportFailedPeople: ["leo"],
    referenceFailedPeople: [],
  });
});

it("joins before and after on slug and fact and refuses a ragged population", () => {
  const before = arm("before", [
    personResult("maya", [judgement("f1", "ambiguous"), judgement("f2", "missing")]),
  ]);
  const after = arm("after", [
    personResult("maya", [judgement("f1", "recovered"), judgement("f2", "missing")]),
  ]);
  const diff = diffArms(before, after);
  expect(diff.transitions).toEqual([
    { slug: "maya", factId: "f1", before: "ambiguous", after: "recovered" },
    { slug: "maya", factId: "f2", before: "missing", after: "missing" },
  ]);
  expect(diff.matrix).toEqual({ ambiguous: { recovered: 1 }, missing: { missing: 1 } });
  expect(() =>
    diffArms(before, arm("after", [personResult("zed", [judgement("f1", "missing")])])),
  ).toThrow("maya");
});

it("classifies each arm's residuals through the shared classifier", () => {
  const people = [
    personResult("maya", [
      judgement("f1", "ambiguous", {
        rationale: "The evidence genuinely does not settle whether Maya led the effort.",
        evidenceQuote: "Maya contributed to the effort.",
        claimId: "claim-0",
      }),
      judgement("f2", "ambiguous", {
        rationale: "Unclear. (Downgraded: the quoted dossier text does not occur in the dossier.)",
        evidenceQuote: null,
        claimId: null,
      }),
      judgement("f3", "recovered"),
    ]),
  ];
  const assignments = classifyArm("smoke", arm("before", people), () => null);
  expect(assignments.map((entry) => [entry.factId, entry.cause])).toEqual([
    ["f1", "judge-semantic-ambiguous"],
    ["f2", "no-evidence-cited-nonempty-dossier"],
  ]);
});

it("renders the record with counts, transitions and causes", () => {
  const before = arm("pre-contract", [personResult("maya", [judgement("f1", "ambiguous")])]);
  const after = arm("contract", [personResult("maya", [judgement("f1", "recovered")])]);
  const side = (label: string, armInput: ContractArm, contract: string) => ({
    label,
    contract,
    recoveryPromptSha256: `${label}-sha`,
    counts: countArm(armInput),
    causes: summarizeAssignments(classifyArm("smoke", armInput, () => null)),
  });
  const markdown = renderContractDifferentialMarkdown({
    title: "Smoke differential",
    conditions: [{ label: "Corpus", value: "abc" }],
    before: side("pre-contract", before, "2026-09-06.8 behavior"),
    after: side("contract", after, "2026-09-06.10"),
    diff: diffArms(before, after),
    notes: ["A note."],
  });
  expect(markdown).toContain("Ambiguous reduction before → after: **1** (1 → 0).");
  expect(markdown).toContain("- maya/f1: ambiguous → recovered");
  expect(markdown).toContain("- judge-semantic-ambiguous: 1");
  expect(markdown).toContain("No support-phase failures in either arm");
});
