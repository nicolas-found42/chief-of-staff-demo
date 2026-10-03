import { describe, expect, it } from "vitest";
import {
  CITATION_SUPPORT_PER_SOURCE_BUDGET,
  CITATION_SUPPORT_QUESTION_REVISION,
  shadowCitationSupport,
  type CitationSupportJudger,
} from "../../../apps/server/src/person-profile/citation-support";
import type { PersonClaim, PersonSourceDocument } from "@chief-of-staff-demo/shared";

const SOURCE: PersonSourceDocument = {
  id: "src-1",
  url: "https://example.com/profile",
  text: [
    "Public profile name: Avery Stone",
    "Avery spearheaded the Atlas scheduler project in 2024.",
    "Avery said that the Atlas scheduler exists.",
    "Avery was not the founder of ExampleCode.",
  ].join("\n"),
  attribution: "third-party",
  sourceClass: "profile",
  capturedAt: "2026-09-01T00:00:00.000Z",
} as unknown as PersonSourceDocument;

function claim(overrides: Partial<PersonClaim>): PersonClaim {
  return {
    id: "claim-1",
    section: "career",
    statement: "Avery led the Atlas scheduler project.",
    status: "supported",
    nature: "statement",
    matchConfidence: "high",
    effectiveFrom: "2024",
    effectiveTo: null,
    citations: [
      { sourceId: "src-1", quote: "Avery spearheaded the Atlas scheduler project in 2024." },
    ],
    supports: [],
    supersedes: [],
    changeReason: null,
    ...overrides,
  };
}

describe("citation-support shadow verification (#504)", () => {
  it("judges each claim and records the published status beside the verdict", async () => {
    const judger: CitationSupportJudger = async ({ claim }) =>
      claim.statement.includes("led")
        ? { support: "supported", confidence: 0.9 }
        : { support: "insufficient", confidence: 0.8 };
    const records = await shadowCitationSupport({
      claims: [
        claim({ id: "c1", statement: "Avery led the Atlas scheduler project." }),
        claim({
          id: "c2",
          statement: "Avery built the Atlas scheduler.",
          citations: [{ sourceId: "src-1", quote: "Avery said that the Atlas scheduler exists." }],
        }),
      ],
      source: SOURCE,
      judger,
    });
    expect(records).toHaveLength(2);
    const [first, second] = records;
    expect(first).toMatchObject({
      claimId: "c1",
      sourceId: "src-1",
      capturedAt: "2026-09-01T00:00:00.000Z",
      questionRevision: CITATION_SUPPORT_QUESTION_REVISION,
      outcome: "judged",
      publishedStatus: "supported",
    });
    expect(first.verdict).toEqual({ support: "supported", confidence: 0.9 });
    expect(second.verdict).toEqual({ support: "insufficient", confidence: 0.8 });
    /* The shadow record never changes the claim. */
    expect(second.publishedStatus).toBe("supported");
  });

  it("records a failed judgment without throwing, leaving the outcome unchanged", async () => {
    const judger: CitationSupportJudger = async () => null;
    const records = await shadowCitationSupport({
      claims: [claim({ id: "c1" })],
      source: SOURCE,
      judger,
    });
    expect(records[0]).toMatchObject({
      outcome: "failed",
      verdict: null,
      publishedStatus: "supported",
    });
  });

  it("marks claims beyond the per-source budget as skipped", async () => {
    const judged: string[] = [];
    const judger: CitationSupportJudger = async ({ claim }) => {
      judged.push(claim.id);
      return { support: "supported", confidence: 0.9 };
    };
    const claims = Array.from({ length: CITATION_SUPPORT_PER_SOURCE_BUDGET + 3 }, (_, index) =>
      claim({ id: `bulk-${index}` }),
    );
    const records = await shadowCitationSupport({ claims, source: SOURCE, judger });
    expect(records).toHaveLength(CITATION_SUPPORT_PER_SOURCE_BUDGET + 3);
    expect(judged).toHaveLength(CITATION_SUPPORT_PER_SOURCE_BUDGET);
    expect(records.filter((record) => record.outcome === "skipped")).toHaveLength(3);
  });

  it("runs nothing without a judger — the production default while shadowed", async () => {
    const records = await shadowCitationSupport({ claims: [claim({ id: "c1" })], source: SOURCE });
    expect(records).toEqual([]);
  });

  it("pins the question revision", () => {
    expect(CITATION_SUPPORT_QUESTION_REVISION).toBe(1);
  });
});
