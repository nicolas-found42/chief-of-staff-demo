import { describe, expect, it } from "vitest";
import {
  findLeftoverPlaceholders,
  substituteProfile,
  substituteProfileStrict,
} from "@chief-of-staff/workflow";
import { makeTestProfile } from "../helpers/engine.js";

const EMAIL_PROMPT = `My name is [YOUR NAME]. 
I am [YOUR TITLE] at [YOUR COMPANY]. 
[DESCRIBE YOUR WRITING STYLE, e.g. "I am concise in my communication, polite but direct. I prefer shorter emails."]

[YOUR NAME]'s key focus areas for their business, [YOUR COMPANY], include the following:
[LIST YOUR KEY FOCUS AREAS HERE, e.g.:
1) Focus Area 1 — Description
2) Focus Area 2 — Description
3) Focus Area 3 — Description]

Keep it under 1000 words.`;

describe("profile substitution", () => {
  it("replaces every bracketed placeholder from the profile", () => {
    const substituted = substituteProfile(EMAIL_PROMPT, makeTestProfile());
    expect(substituted).toContain("My name is Ada Lovelace.");
    expect(substituted).toContain("I am Chief of Staff at Analytical Engines Inc.");
    expect(substituted).toContain("I am concise in my communication, polite but direct.");
    expect(substituted).toContain("1) Customer success: reduce churn and expand accounts");
    expect(substituted).not.toContain("[YOUR NAME]");
    expect(substituted).not.toContain("[YOUR TITLE]");
    expect(substituted).not.toContain("[YOUR COMPANY]");
  });

  it("preserves every other character, spacing, and line break exactly", () => {
    const profile = makeTestProfile();
    const substituted = substituteProfile(EMAIL_PROMPT, profile);
    // Everything before the first placeholder is untouched.
    expect(substituted.startsWith("My name is ")).toBe(true);
    // The template's own punctuation and line breaks survive verbatim, so the
    // literal ". " after the [YOUR COMPANY] placeholder is preserved.
    expect(substituted).toContain("Ada Lovelace. \nI am Chief of Staff at Analytical Engines Inc.. \n");
    // The trailing instruction is untouched.
    expect(substituted.endsWith("Keep it under 1000 words.")).toBe(true);
  });

  it("rejects runs when a placeholder would remain after substitution", () => {
    const profile = makeTestProfile();
    profile.focusAreas = [];
    expect(() => substituteProfileStrict(EMAIL_PROMPT, { ...profile, focusAreas: [] })).not.toThrow();
    // A prompt with a placeholder the profile cannot fill must fail.
    expect(() =>
      substituteProfileStrict("Send to [YOUR EMAIL ADDRESS] please", makeTestProfile())
    ).toThrow(/INVALID_CONFIGURATION|placeholder/i);
  });

  it("detects leftover placeholders of every documented shape", () => {
    const leftovers = findLeftoverPlaceholders(
      "[YOUR NAME] and [YOUR TITLE], see [DESCRIBE YOUR WRITING STYLE, x] and [LIST YOUR KEY FOCUS AREAS HERE, y]"
    );
    expect(leftovers).toEqual([
      "[YOUR NAME]",
      "[YOUR TITLE]",
      "[DESCRIBE YOUR WRITING STYLE, x]",
      "[LIST YOUR KEY FOCUS AREAS HERE, y]",
    ]);
  });

  it("replaces focus areas as a numbered list", () => {
    const substituted = substituteProfile(EMAIL_PROMPT, makeTestProfile());
    expect(substituted).toContain("1) Customer success: reduce churn and expand accounts\n2) Product quality: ship reliable releases\n3) Operational efficiency: automate repeatable work");
  });
});
