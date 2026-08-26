import { describe, expect, it } from "vitest";
import { modelBrandProfileProposer } from "../../../apps/server/src/modules/content-scout/brand-profile";

const VALID_SECTIONS = {
  Summary: "A concise company summary.",
  Products: "The core product.",
  Customers: "Operations leaders.",
  "Customer problems": "Fragmented work.",
  Positioning: "Practical guidance.",
  Differentiators: "Local ownership.",
  Proof: "Published customer evidence.",
  Competitors: "Manual processes.",
  Voice: "Direct and clear.",
  Vocabulary: "Use precise terms.",
  "Prohibited claims": "No unsupported guarantees.",
  "Content themes": "Operational clarity.",
  "Avoided subjects": "Unverified rumors.",
  "Geographic or regulatory constraints": "United States only.",
};

describe("modelBrandProfileProposer", () => {
  it("names every missing Brand Profile section", async () => {
    const proposer = modelBrandProfileProposer(() => async () => ({ Summary: "Company summary" }));

    await expect(proposer.propose({ pages: [] })).rejects.toThrow(
      "Missing Brand Profile sections: Products, Customers, Customer problems, Positioning, Differentiators, Proof, Competitors, Voice, Vocabulary, Prohibited claims, Content themes, Avoided subjects, Geographic or regulatory constraints",
    );
  });

  it("asks for named sections and assembles the Brand Profile Markdown", async () => {
    let requestedShape: { safeParse(value: unknown): { success: boolean } } | undefined;
    const proposer = modelBrandProfileProposer(() => async (request) => {
      requestedShape = request.schema;
      return VALID_SECTIONS;
    });

    const markdown = await proposer.propose({ pages: [] });

    expect(requestedShape?.safeParse(VALID_SECTIONS).success).toBe(true);
    expect(markdown).toBe(`# Brand Profile

## Summary
A concise company summary.

## Products
The core product.

## Customers
Operations leaders.

## Customer problems
Fragmented work.

## Positioning
Practical guidance.

## Differentiators
Local ownership.

## Proof
Published customer evidence.

## Competitors
Manual processes.

## Voice
Direct and clear.

## Vocabulary
Use precise terms.

## Prohibited claims
No unsupported guarantees.

## Content themes
Operational clarity.

## Avoided subjects
Unverified rumors.

## Geographic or regulatory constraints
United States only.
`);
  });

  it("rejects an empty section before the proposal can be diffed", async () => {
    const proposer = modelBrandProfileProposer(() => async () => ({
      ...VALID_SECTIONS,
      Summary: "",
    }));

    await expect(proposer.propose({ pages: [] })).rejects.toThrow(
      "Empty Brand Profile sections: Summary",
    );
  });
});
