import { describe, expect, test } from "vitest";
import { ExtractionSchema } from "../../../apps/server/src/person-profile/extraction-parts.js";
import {
  claimNamesSubject,
  declaresOtherSubject,
} from "../../../apps/server/src/person-profile/subject-attribution.js";
import {
  denseMultiClaim,
  duplicateLocalIds,
  noRelevantFacts,
  sparseIdentityOnly,
  wrongSubjectAdmittedClaimIds,
  wrongSubjectDocument,
  wrongSubjectExtraction,
  wrongSubjectProfile,
  wrongSubjectWithheldClaimIds,
} from "./person-research-extraction-boundary-fixtures.js";

/**
 * Proves each boundary fixture (#418 spec §3) is internally self-consistent:
 * every citation quote really is a verbatim substring of its document, and
 * each fixture exercises the specific structural obligation it claims to.
 * This does not exercise the live extraction pipeline — that is #418's
 * probe/slice work, which consumes these fixtures separately.
 */

function allQuotes(extraction: { claims: { citations: { quote: string }[] }[] }): string[] {
  return extraction.claims.flatMap((claim) => claim.citations.map((citation) => citation.quote));
}

describe("dense multi-claim fixture", () => {
  test("validates against the real ExtractionSchema", () => {
    expect(() => ExtractionSchema.parse(denseMultiClaim.extraction)).not.toThrow();
  });

  test("exercises claims, a work, expertise, a connection and sections", () => {
    const { extraction } = denseMultiClaim;
    expect(extraction.claims.length).toBeGreaterThanOrEqual(5);
    expect(extraction.works.length).toBeGreaterThanOrEqual(1);
    expect(extraction.expertise.length).toBeGreaterThanOrEqual(1);
    expect(extraction.connections.length).toBeGreaterThanOrEqual(1);
    expect(extraction.sections.length).toBeGreaterThanOrEqual(1);
  });

  test("every citation quote is a verbatim substring of the document", () => {
    for (const quote of allQuotes(denseMultiClaim.extraction))
      expect(denseMultiClaim.documentText.includes(quote)).toBe(true);
  });

  test("every claimIds reference resolves to an admitted claim", () => {
    const claimIds = new Set(denseMultiClaim.extraction.claims.map((claim) => claim.id));
    for (const record of denseMultiClaim.extraction.works)
      for (const id of record.claimIds) expect(claimIds.has(id)).toBe(true);
    for (const record of denseMultiClaim.extraction.expertise)
      for (const id of record.claimIds) expect(claimIds.has(id)).toBe(true);
    for (const record of denseMultiClaim.extraction.connections)
      for (const id of record.claimIds) expect(claimIds.has(id)).toBe(true);
  });
});

describe("sparse identity-only fixture", () => {
  test("validates and carries only identity/source-metadata facts", () => {
    expect(() => ExtractionSchema.parse(sparseIdentityOnly.extraction)).not.toThrow();
    const { extraction } = sparseIdentityOnly;
    expect(extraction.fullName).not.toBeNull();
    expect(extraction.employer).not.toBeNull();
    expect(extraction.author).not.toBeNull();
    expect(extraction.publishedAt).not.toBeNull();
    expect(extraction.claims).toEqual([]);
    expect(extraction.works).toEqual([]);
    expect(extraction.expertise).toEqual([]);
    expect(extraction.connections).toEqual([]);
    expect(extraction.sections).toEqual([]);
  });
});

describe("no-relevant-facts fixture", () => {
  test("is a legitimate validated empty Extraction, not an absent answer", () => {
    const parsed = ExtractionSchema.parse(noRelevantFacts.extraction);
    // A real object came back from validation: this is the "no answer" case
    // stays distinguishable from a null/undefined model reply.
    expect(parsed).toBeTruthy();
    expect(parsed.claims).toEqual([]);
    expect(parsed.works).toEqual([]);
    expect(parsed.expertise).toEqual([]);
    expect(parsed.connections).toEqual([]);
    expect(parsed.sections).toEqual([]);
    expect(parsed.fullName).toBeNull();
    expect(parsed.employer).toBeNull();
  });
});

describe("cross-part duplicate local IDs fixture", () => {
  test("both parts validate independently against ExtractionSchema", () => {
    expect(() => ExtractionSchema.parse(duplicateLocalIds.partA.extraction)).not.toThrow();
    expect(() => ExtractionSchema.parse(duplicateLocalIds.partB.extraction)).not.toThrow();
  });

  test("the two parts really do collide on the same local claim and work ids", () => {
    const claimA = duplicateLocalIds.partA.extraction.claims[0];
    const claimB = duplicateLocalIds.partB.extraction.claims[0];
    const workA = duplicateLocalIds.partA.extraction.works[0];
    const workB = duplicateLocalIds.partB.extraction.works[0];
    expect(claimA.id).toBe(claimB.id);
    expect(workA.id).toBe(workB.id);
    // The collision is on the id alone: the two parts invented it
    // independently to describe genuinely different facts.
    expect(claimA.statement).not.toBe(claimB.statement);
    expect(workA.title).not.toBe(workB.title);
  });

  test("every citation quote is a verbatim substring of its own part's document", () => {
    for (const quote of allQuotes(duplicateLocalIds.partA.extraction))
      expect(duplicateLocalIds.partA.documentText.includes(quote)).toBe(true);
    for (const quote of allQuotes(duplicateLocalIds.partB.extraction))
      expect(duplicateLocalIds.partB.documentText.includes(quote)).toBe(true);
  });
});

describe("wrong-subject fixture (ADR-0097)", () => {
  test("validates against the real ExtractionSchema", () => {
    expect(() => ExtractionSchema.parse(wrongSubjectExtraction)).not.toThrow();
  });

  test("every citation quote is a verbatim substring of the document", () => {
    for (const quote of allQuotes(wrongSubjectExtraction))
      expect(wrongSubjectDocument.includes(quote)).toBe(true);
  });

  test("the document really does declare a different subject", () => {
    expect(declaresOtherSubject(wrongSubjectDocument, wrongSubjectProfile)).toBe(true);
  });

  test("claimNamesSubject admits the claim whose cited sentence names the subject", () => {
    const admitted = wrongSubjectExtraction.claims.filter((claim) =>
      wrongSubjectAdmittedClaimIds.includes(claim.id),
    );
    expect(admitted).toHaveLength(wrongSubjectAdmittedClaimIds.length);
    for (const claim of admitted)
      expect(claimNamesSubject(claim, wrongSubjectDocument, wrongSubjectProfile)).toBe(true);
  });

  test("claimNamesSubject refuses the claims that are genuinely about the other subject", () => {
    const withheld = wrongSubjectExtraction.claims.filter((claim) =>
      wrongSubjectWithheldClaimIds.includes(claim.id),
    );
    expect(withheld).toHaveLength(wrongSubjectWithheldClaimIds.length);
    for (const claim of withheld)
      expect(claimNamesSubject(claim, wrongSubjectDocument, wrongSubjectProfile)).toBe(false);
  });
});
