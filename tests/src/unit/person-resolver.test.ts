import { describe, expect, it } from "vitest";
import {
  matchCandidateNameToSlug,
  matchPersonEvidence,
} from "../../../apps/server/src/person-profile/resolver.js";
import type { PersonIdentitySignals } from "@chief-of-staff-demo/shared";

describe("matchCandidateNameToSlug", () => {
  it("matches standard concatenated names and initial contractions in social slugs", () => {
    // Jose Ceres with middle/maternal initial 'c' (Cervantes)
    expect(matchCandidateNameToSlug("Jose Ceres", "joseceresc")).toBe(true);
    expect(matchCandidateNameToSlug("Jose Ceres Escamilla", "joseceresc")).toBe(true);
    expect(matchCandidateNameToSlug("Jose Ceres", "jose-ceres")).toBe(true);
    expect(matchCandidateNameToSlug("Richard Achee", "richardachee")).toBe(true);
    expect(matchCandidateNameToSlug("Richard Achee", "richard-achee")).toBe(true);
    // LinkedIn slugs with random numeric/alphanumeric suffix
    expect(matchCandidateNameToSlug("Shaye James", "shaye-james-b85087143")).toBe(true);
    expect(matchCandidateNameToSlug("Maya Okafor", "maya-okafor-123456")).toBe(true);
  });

  it("rejects names that do not match the slug or represent different people", () => {
    expect(matchCandidateNameToSlug("John Doe", "joseceresc")).toBe(false);
    expect(matchCandidateNameToSlug("Jane Ceres", "joseceresc")).toBe(false);
    expect(matchCandidateNameToSlug("Jose Santos", "joseceresc")).toBe(false);
    expect(matchCandidateNameToSlug("Robert Achee", "richardachee")).toBe(false);
    expect(matchCandidateNameToSlug("James Shaye", "shaye-james-b85087143")).toBe(false);
  });

  it("handles empty or degenerate inputs safely", () => {
    expect(matchCandidateNameToSlug("", "joseceresc")).toBe(false);
    expect(matchCandidateNameToSlug("Jose Ceres", "")).toBe(false);
    expect(matchCandidateNameToSlug("   ", "   ")).toBe(false);
  });
});

describe("matchPersonEvidence standard evidence matching", () => {
  const baseSignals = (overrides: Partial<PersonIdentitySignals>): PersonIdentitySignals => ({
    emails: [],
    fullNames: [],
    handles: {},
    profileUrls: [],
    employerHints: [],
    ...overrides,
  });

  it("matches full names exactly and assigns medium confidence", () => {
    const requested = baseSignals({ fullNames: ["Jose Ceres"] });
    const observed = baseSignals({ fullNames: ["Jose Ceres"] });
    const match = matchPersonEvidence(requested, observed);
    expect(match).not.toBeNull();
    expect(match?.confidence).toBe("medium");
    expect(match?.matchedSignals).toContain("fullName:jose ceres");
  });

  it("upgrades to high confidence when employer hint matches alongside full name", () => {
    const requested = baseSignals({
      fullNames: ["Jose Ceres"],
      employerHints: ["CloudScale"],
    });
    const observed = baseSignals({
      fullNames: ["Jose Ceres"],
      employerHints: ["CloudScale"],
    });
    const match = matchPersonEvidence(requested, observed);
    expect(match).not.toBeNull();
    expect(match?.confidence).toBe("high");
  });

  it("strictly preserves contradictory email and handle rejections", () => {
    const requested = baseSignals({
      fullNames: ["Jose Ceres"],
      emails: ["jose@example.com"],
      handles: { github: ["josec"] },
    });
    const observed = baseSignals({
      fullNames: ["Jose Ceres"],
      emails: ["other@example.com"],
      handles: { github: ["other"] },
    });
    const match = matchPersonEvidence(requested, observed);
    expect(match).toBeNull();
  });
});
