import { createHttpFetch } from "../http.js";
import type { PublicHttpFetch } from "../http.js";
import type { PublicSearchResult } from "../search.js";
import { ProviderRefusedError } from "./types.js";
import type { SearchProvider, SearchProviderIo } from "./types.js";

const MAX_RESULTS = 8;
const TITLE_LIMIT = 200;
const SNIPPET_LIMIT = 400;

type SearxngResult = { url?: unknown; title?: unknown; content?: unknown };

type SearxngResponse = { results?: unknown; unresponsive_engines?: unknown };

const MAX_REPORTED_ENGINES = 6;

/** `unresponsive_engines` carries `[engine, reason]` pairs; older bodies carry
    bare engine names. An entry of any other shape is reported verbatim rather
    than dropped, because the reason is the whole point of reading it. */
function engineFailures(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (typeof entry === "string") return entry;
      if (Array.isArray(entry)) return entry.filter((part) => typeof part === "string").join(": ");
      return JSON.stringify(entry);
    })
    .filter((text) => text.length > 0);
}

function absoluteHttpUrl(value: string | null): string | null {
  if (value === null) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * SearXNG is self-hosted (see ADR-0049): the base URL is fixed configuration,
 * not caller input, so the SSRF guard's ban on private/compose-internal
 * hostnames must not apply here — `createHttpFetch({ guarded: false })`.
 * The instance must also enable `formats: [json]` in its settings or it
 * answers a 403, which we classify as "error" rather than rate-limiting.
 */
export function createSearxngProvider(options: {
  baseUrl: string;
  fetch?: PublicHttpFetch;
}): SearchProvider {
  const base = options.baseUrl.replace(/\/+$/, "");
  const fetch = options.fetch ?? createHttpFetch({ guarded: false });

  return {
    name: "searxng",
    async search(query: string, io: SearchProviderIo): Promise<PublicSearchResult[]> {
      const url = `${base}/search?q=${encodeURIComponent(query)}&format=json`;
      // The curated transport (not io.fetch) is the point of this provider —
      // see the factory comment above.
      const response = await fetch(url, { timeoutMs: io.timeoutMs });

      if (response.status !== 200) {
        throw new ProviderRefusedError(
          "error",
          `searxng answered HTTP ${response.status} (JSON format likely disabled on the instance)`,
        );
      }

      let parsed: SearxngResponse;
      try {
        parsed = JSON.parse(response.body) as SearxngResponse;
      } catch {
        throw new ProviderRefusedError("error", "searxng returned an unparseable body");
      }
      if (!Array.isArray(parsed.results)) {
        throw new ProviderRefusedError("error", "searxng returned a body without results[]");
      }

      const results: PublicSearchResult[] = [];
      for (const raw of parsed.results.slice(0, MAX_RESULTS)) {
        const candidate = raw as SearxngResult;
        // A result without a usable URL is dropped, never invented.
        const resultUrl = absoluteHttpUrl(typeof candidate.url === "string" ? candidate.url : null);
        if (resultUrl === null) continue;
        results.push({
          title: (typeof candidate.title === "string" ? candidate.title : "").slice(0, TITLE_LIMIT),
          url: resultUrl,
          snippet: (typeof candidate.content === "string" ? candidate.content : "").slice(
            0,
            SNIPPET_LIMIT,
          ),
        });
      }
      /* No results while engines failed server-side is a refusal, not an
         answer: the query never reached a working engine, and recording it as
         "the web knows nothing" is the misdiagnosis ADR-0049 asks this seam to
         avoid. It is classed transient because suspension is per-engine and
         short-lived - a cooldown here would bench the whole instance over the
         engines that are walled by design. */
      if (results.length === 0) {
        const failures = engineFailures(parsed.unresponsive_engines);
        if (failures.length > 0)
          throw new ProviderRefusedError(
            "error",
            `searxng returned no results; engines failed: ${failures
              .slice(0, MAX_REPORTED_ENGINES)
              .join(", ")}`,
          );
      }
      return results;
    },
  };
}
