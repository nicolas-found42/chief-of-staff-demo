import { describe, expect, it } from "vitest";
import {
  extractIdentitySignalsFromSearchResult,
  seedQueries,
} from "../../../apps/server/src/person-profile/research-plan.js";
import type { PersonProfile } from "@chief-of-staff-demo/shared";
import { fromPartial } from "@total-typescript/shoehorn";

describe("seedQueries for URL-only profiles", () => {
  it("emits standard name-based queries when fullName is provided", () => {
    const profile = fromPartial<PersonProfile>({
      fullName: "Maya Okafor",
      currentEmployer: "Coastal Observatory",
      emails: ["maya@example.com"],
      employerHints: ["Observatory"],
      profileUrls: [],
      handles: {},
    });
    const seeds = seedQueries(profile);
    expect(seeds).toContain("maya@example.com");
    expect(seeds).toContain('"Maya Okafor" Coastal Observatory');
    expect(seeds).toContain('"Maya Okafor" biography role career');
  });

  it("emits diversified identity bootstrap queries when fullName is null", () => {
    const profile = fromPartial<PersonProfile>({
      fullName: null,
      currentEmployer: null,
      emails: [],
      employerHints: ["CloudScale"],
      profileUrls: ["https://www.linkedin.com/in/joseceresc/"],
      handles: { linkedin: ["joseceresc"] },
    });
    const seeds = seedQueries(profile);
    expect(seeds).toContain("site:linkedin.com/in/joseceresc");
    expect(seeds).toContain('"linkedin.com/in/joseceresc"');
    expect(seeds).toContain('"joseceresc" (github OR blog OR "about me" OR cv)');
    expect(seeds).toContain('"joseceresc" CloudScale');
  });

  it("handles profile with raw profile URL but no populated handles map", () => {
    const profile = fromPartial<PersonProfile>({
      fullName: null,
      currentEmployer: null,
      emails: [],
      employerHints: [],
      profileUrls: ["https://www.linkedin.com/in/richardachee"],
      handles: {},
    });
    const seeds = seedQueries(profile);
    expect(seeds).toContain("site:linkedin.com/in/richardachee");
    expect(seeds).toContain('"linkedin.com/in/richardachee"');
  });
});

describe("extractIdentitySignalsFromSearchResult", () => {
  const targetUrl = "https://www.linkedin.com/in/joseceresc";

  it("extracts full name and role/employer from standard LinkedIn SERP titles", () => {
    const result = {
      url: "https://www.linkedin.com/in/joseceresc",
      title: "Jose Ceres - Senior Platform Engineer - CloudScale | LinkedIn",
    };
    const signal = extractIdentitySignalsFromSearchResult(result, targetUrl);
    expect(signal).toEqual({
      fullName: "Jose Ceres",
      employerHints: ["Senior Platform Engineer - CloudScale", "CloudScale"],
    });
  });

  it("preserves hyphens inside candidate names when splitting the headline", () => {
    const hyphenated = {
      url: "https://www.linkedin.com/in/annemariesmith",
      title: "Anne-Marie Smith - CEO | LinkedIn",
    };
    expect(extractIdentitySignalsFromSearchResult(hyphenated, hyphenated.url)).toEqual({
      fullName: "Anne-Marie Smith",
      employerHints: ["CEO"],
    });
  });

  it("handles en-dash and em-dash separators and 'at' company phrasing", () => {
    const resultEnDash = {
      url: "https://www.linkedin.com/in/joseceresc/",
      title: "Jose Ceres – Lead Architect at CloudScale | LinkedIn",
    };
    expect(extractIdentitySignalsFromSearchResult(resultEnDash, targetUrl)).toEqual({
      fullName: "Jose Ceres",
      employerHints: ["Lead Architect at CloudScale", "CloudScale"],
    });

    const resultEmDash = {
      url: "https://www.linkedin.com/in/joseceresc",
      title: "Jose Ceres — VP Engineering | LinkedIn",
    };
    expect(extractIdentitySignalsFromSearchResult(resultEmDash, targetUrl)).toEqual({
      fullName: "Jose Ceres",
      employerHints: ["VP Engineering"],
    });
  });

  it("rejects search results whose URL does not canonicalize to the target profile URL", () => {
    // Third-party article merely referencing or linking the profile
    const thirdPartyResult = {
      url: "https://techblog.example.com/posts/platform-engineering",
      title: "Jose Ceres - Senior Engineer | LinkedIn",
    };
    expect(extractIdentitySignalsFromSearchResult(thirdPartyResult, targetUrl)).toBeNull();

    // Different LinkedIn profile
    const otherProfileResult = {
      url: "https://www.linkedin.com/in/other-person",
      title: "Jose Ceres - Engineer | LinkedIn",
    };
    expect(extractIdentitySignalsFromSearchResult(otherProfileResult, targetUrl)).toBeNull();
  });

  it("rejects candidate titles that fail similarity matching against the target slug", () => {
    const mismatchedNameResult = {
      url: "https://www.linkedin.com/in/joseceresc",
      title: "John Doe - Recruiter | LinkedIn",
    };
    expect(extractIdentitySignalsFromSearchResult(mismatchedNameResult, targetUrl)).toBeNull();
  });
});
