import { describe, expect, test } from "vitest";
import { personOverviewClaims, type PersonClaim } from "@chief-of-staff-demo/shared";

/**
 * The Overview's claim selection (UX audit F6): identity facts — name, role,
 * employer — lead no matter when the pipeline discovered them, the summary
 * keeps its six-claim cap, and the coverage tails stay at the tail.
 */
function claim(overrides: Partial<PersonClaim> & { id: string }): PersonClaim {
  return {
    section: "work",
    statement: "A statement.",
    status: "supported",
    nature: "statement",
    matchConfidence: "high",
    effectiveFrom: null,
    effectiveTo: null,
    citations: [],
    supports: [],
    supersedes: [],
    changeReason: null,
    ...overrides,
  };
}

describe("personOverviewClaims", () => {
  test("leads with role, employer and name facts ahead of what the pipeline discovered first", () => {
    const claims = [
      claim({ id: "trivia", statement: "Listed in a 2019 conference attendee export." }),
      claim({
        id: "employer",
        statement: "Works at Northline.",
        fact: { field: "currentEmployer", value: "Northline" },
      }),
      claim({
        id: "role",
        statement: "Chief of staff at Northline.",
        fact: { field: "role", value: "Chief of staff" },
      }),
      claim({
        id: "name",
        statement: "Maya Chen.",
        fact: { field: "fullName", value: "Maya Chen" },
      }),
    ];
    expect(personOverviewClaims(claims).map((c) => c.id)).toEqual([
      "name",
      "role",
      "employer",
      "trivia",
    ]);
  });

  test("keeps the six-claim summary cap, identity facts included", () => {
    const claims = [
      claim({ id: "role", fact: { field: "role", value: "Chief of staff" } }),
      claim({ id: "employer", fact: { field: "currentEmployer", value: "Northline" } }),
      ...Array.from({ length: 8 }, (_, index) =>
        claim({ id: `fact-${index}`, statement: `Discovered fact ${index}.` }),
      ),
    ];
    const overview = personOverviewClaims(claims);
    expect(overview).toHaveLength(6);
    expect(overview.slice(0, 2).map((c) => c.id)).toEqual(["role", "employer"]);
  });

  test("caps identity claims themselves when they alone exceed the summary", () => {
    const claims = [
      ...Array.from({ length: 7 }, (_, index) =>
        claim({
          id: `role-${index}`,
          statement: `Role fact ${index}.`,
          fact: { field: "role", value: `Role ${index}` },
        }),
      ),
      claim({ id: "trivia", statement: "A later discovery." }),
    ];
    const overview = personOverviewClaims(claims);
    expect(overview).toHaveLength(6);
    expect(overview.every((c) => c.id.startsWith("role-"))).toBe(true);
    expect(overview.map((c) => c.id)).not.toContain("trivia");
  });

  test("keeps incomplete education and unresolved fragments at the tail", () => {
    const claims = [
      claim({
        id: "unresolved",
        statement: "Unresolved source fragment: something.",
        status: "unknown",
      }),
      claim({
        id: "incomplete-education",
        statement: "Education — Institution unknown.",
        status: "unknown",
      }),
      claim({ id: "role", fact: { field: "role", value: "Chief of staff" } }),
    ];
    expect(personOverviewClaims(claims).map((c) => c.id)).toEqual([
      "role",
      "incomplete-education",
      "unresolved",
    ]);
  });
});
