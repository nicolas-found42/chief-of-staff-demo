import type { PersonProfile } from "@chief-of-staff-demo/shared";
import { createPublicSearch, type PublicSearch } from "../source-adapters/search.js";
import type { readPersonSource } from "../person-profile/research-readers.js";

/**
 * The two pipelines a comparison holds apart.
 *
 * `expanded` is what the application ships. `incumbent` reconstructs the
 * pipeline as it stood before issue #228, from the outside: the provider
 * bundle it had, the merged ceiling it had, the two readers it had, the narrow
 * seed set it started from, no planner, serial reading, and its short
 * per-profile allowance.
 *
 * This is a *reconstruction*, not the old binary, and the report says so. Two
 * differences it deliberately does not reproduce are named in the comparison's
 * conditions instead of being silently absorbed: the incumbent's stricter
 * identity rule and its per-source retry schedule live inside the orchestrator
 * rather than at a seam, so the baseline runs today's versions of both.
 */
export type BenchmarkPipeline = "incumbent" | "expanded";

/** Providers registered before the #228 source-family expansion (ADR-0049). */
const INCUMBENT_PROVIDERS = new Set([
  "searxng",
  "duckduckgo",
  "mojeek",
  "marginalia",
  "wikipedia",
  "wikidata",
  "bing-news",
  "google-news",
  "gdelt",
  "stackexchange",
  "arctic-shift",
  "reddit-rss",
  "openverse",
  "europepmc",
  "internet-archive",
  "ia-tvnews",
  "wiby",
  "wayback",
  "openalex",
  "orcid",
  "github-users",
  "dblp",
  "ror",
  "gleif",
  "edgar",
]);

/** The incumbent's merged ceiling, before the expansion raised it. */
const INCUMBENT_MERGED_LIMIT = 24;

export interface PipelineConfiguration {
  search: PublicSearch;
  seeds?: (profile: PersonProfile) => string[];
  readSource?: typeof readPersonSource;
  settings: { profileCalls: number; profileMilliseconds: number; readConcurrency: number };
  /** Nonsecret conditions to record in the report's provenance. */
  conditions: Record<string, string | number | boolean>;
}

export function configurePipeline(
  pipeline: BenchmarkPipeline,
  reader: typeof readPersonSource,
  options: { searxngUrl?: string } = {},
): PipelineConfiguration {
  if (pipeline === "expanded")
    return {
      search: createPublicSearch(undefined, undefined, {
        ...(options.searxngUrl !== undefined ? { searxngUrl: options.searxngUrl } : {}),
      }),
      settings: { profileCalls: 60, profileMilliseconds: 900_000, readConcurrency: 4 },
      conditions: {
        providers: "full bundle",
        mergedLimit: 60,
        readers: "html, text, documents, feeds, captions, social, records",
        planner: true,
        readConcurrency: 4,
      },
    };
  return {
    search: createPublicSearch(undefined, undefined, {
      providerFilter: (name) => INCUMBENT_PROVIDERS.has(name),
      mergedLimit: INCUMBENT_MERGED_LIMIT,
      ...(options.searxngUrl !== undefined ? { searxngUrl: options.searxngUrl } : {}),
    }),
    /* The incumbent's seeds: the person's emails, profile URLs and one
       name-plus-employer string, capped at three. */
    seeds: (profile) =>
      [
        ...profile.emails,
        ...profile.profileUrls,
        ...(profile.fullName
          ? [`${profile.fullName} ${profile.currentEmployer ?? ""}`.trim()]
          : []),
      ].slice(0, 3),
    /* The incumbent read HTML and `text/*` and nothing else; every other
       format was recorded as unsupported and fell back to the snippet. */
    readSource: async (url, snippet, ports) => {
      const read = await reader(url, snippet, ports);
      const supported = read.route === "html-reader" || read.route === "text-reader";
      return supported
        ? read
        : {
            ...read,
            text: snippet,
            completeness: snippet ? "snippet" : "unavailable",
            access: "unsupported",
            outboundUrls: [],
            anchors: [],
            provenanceNote:
              "The incumbent pipeline had no reader for this format; the snippet is all it kept.",
          };
    },
    settings: { profileCalls: 12, profileMilliseconds: 120_000, readConcurrency: 1 },
    conditions: {
      providers: `${String(INCUMBENT_PROVIDERS.size)} pre-expansion providers`,
      mergedLimit: INCUMBENT_MERGED_LIMIT,
      readers: "html, text",
      planner: false,
      readConcurrency: 1,
      reconstruction:
        "Configured reconstruction of the pre-#228 pipeline, not the pre-#228 binary; the identity rule and per-source retry schedule are today's.",
    },
  };
}
