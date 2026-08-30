import type { ResonanceHookShape, PeopleSuggestionShape } from "@chief-of-staff-demo/shared";
import { ResonanceHookShapeSchema, PeopleSuggestionShapeSchema } from "@chief-of-staff-demo/shared";
import type { CompleteJson } from "../../llm/providers.js";
import { parseResultShape } from "../../llm/failure.js";

export type HookExtractorFn = (input: {
  personName: string;
  items: {
    title: string | null;
    excerpt: string;
    transcript: string | null;
  }[];
}) => Promise<ResonanceHookShape>;

export type PeopleSuggestorFn = (input: {
  brandProfile: { markdown: string } | null;
  approvedPeople: { name: string }[];
  recentItems: { title: string | null; author: string | null; canonicalUrl: string }[];
}) => Promise<PeopleSuggestionShape>;

export function createHookExtractor(getCompleteJson: () => CompleteJson): HookExtractorFn {
  return async (input) => {
    const prompt = [
      `Explain why ${input.personName}'s content is resonating right now.`,
      `You see only the top evidence (title, excerpt, transcript when present):`,
      JSON.stringify(input.items),
      `Return one hook: the reason it lands, grounded in that evidence and in nothing else.`,
      `Optionally quote one verbatim line as evidenceQuote.`,
    ].join("\n");
    const raw = await getCompleteJson()({
      system: "You extract resonance hooks. Return JSON with hook and optional evidenceQuote.",
      user: prompt,
      schema: ResonanceHookShapeSchema,
    });
    return parseResultShape("ResonanceHookShape", ResonanceHookShapeSchema, raw);
  };
}

export function createPeopleDiscoverer(getCompleteJson: () => CompleteJson): PeopleSuggestorFn {
  return async (input) => {
    const prompt = [
      input.brandProfile
        ? `The workspace's Brand Profile:\n${input.brandProfile.markdown.slice(0, 2000)}`
        : "No Brand Profile is configured.",
      `People already watched: ${input.approvedPeople.map((p) => p.name).join(", ") || "none"}.`,
      `Recently collected public items (title, author, url) — co-mentions, citations, and outbound links in these are the signals:`,
      JSON.stringify(input.recentItems.slice(0, 50)),
      `Propose at most three new people worth watching. Every supportingUrl must be copied verbatim from the collected items; never invent a URL.`,
    ].join("\n");
    const raw = await getCompleteJson()({
      system: "You propose Person Suggestions. Return JSON with candidates array.",
      user: prompt,
      schema: PeopleSuggestionShapeSchema,
    });
    return parseResultShape("PeopleSuggestionShape", PeopleSuggestionShapeSchema, raw);
  };
}
