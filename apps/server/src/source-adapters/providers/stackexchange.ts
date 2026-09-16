import { retryAfterMilliseconds } from "../http.js";
import type { PublicHttpFetch } from "../http.js";
import type { PublicSearchResult } from "../search.js";
import { ProviderRefusedError } from "./types.js";
import type { SearchProvider, SearchProviderIo } from "./types.js";

const MAX_RESULTS = 8;
const TITLE_LIMIT = 200;
const SNIPPET_LIMIT = 400;

/** The excerpts endpoint wraps matched terms in `<span class="highlight">`;
 * stored snippets keep the matched words, not the decoration. */
const HIGHLIGHT_MARKUP = /<\/?span(?:\s[^>]*)?>/g;

function readsAsBackoffSeconds(value: unknown): value is { backoff: number } {
  return (
    typeof value === "object" &&
    value !== null &&
    "backoff" in value &&
    typeof value.backoff === "number"
  );
}

function hasExcerptItems(value: unknown): value is { items: unknown[] } {
  return (
    typeof value === "object" && value !== null && "items" in value && Array.isArray(value.items)
  );
}

function isExcerptHit(
  value: unknown,
): value is { title: unknown; question_id: unknown; excerpt: unknown } {
  return typeof value === "object" && value !== null && "title" in value && "question_id" in value;
}

/**
 * Stack Exchange excerpts (ADR-0049, layer 3) — real keyless full-text search
 * of the technical Q&A corpus. HTTP 400 can carry an IP throttle; a
 * successful reply can instead request method backoff while retaining its
 * valid results. Neither path retries inside the query.
 */
export function createStackExchangeProvider(
  options: { fetch?: PublicHttpFetch } = {},
): SearchProvider {
  return {
    name: "stackexchange",
    async search(query: string, io: SearchProviderIo): Promise<PublicSearchResult[]> {
      const fetch = options.fetch ?? io.fetch;
      const response = await fetch(
        `https://api.stackexchange.com/2.3/search/excerpts?order=desc&sort=relevance&q=${encodeURIComponent(query)}&site=stackoverflow`,
        { timeoutMs: io.timeoutMs },
      );

      // This API uses HTTP 400 for method errors, including IP throttles.
      // Reading only the HTTP status bypasses the composite's cooldown.
      if (response.status === 400) {
        let error: unknown;
        try {
          error = JSON.parse(response.body);
        } catch {
          error = null;
        }
        if (
          typeof error === "object" &&
          error !== null &&
          "error_name" in error &&
          error.error_name === "throttle_violation"
        ) {
          const seconds =
            "error_message" in error && typeof error.error_message === "string"
              ? Number(/more requests available in (\d+) seconds/i.exec(error.error_message)?.[1])
              : NaN;
          const delay = readsAsBackoffSeconds(error) ? error.backoff * 1000 : seconds * 1000;
          throw new ProviderRefusedError(
            "rate-limited",
            "stackexchange is rate-limited: the API reported throttle_violation.",
            Math.max(
              retryAfterMilliseconds(response.retryAfter, new Date()) ?? 0,
              Number.isSafeInteger(delay) && delay > 0 ? delay : 0,
            ) || undefined,
          );
        }
      }

      if (response.status !== 200) {
        if (response.status === 429 || response.status === 503) {
          throw new ProviderRefusedError(
            "rate-limited",
            `stackexchange is rate-limited: search/excerpts answered ${String(response.status)}.`,
            retryAfterMilliseconds(response.retryAfter, new Date()),
          );
        }
        throw new ProviderRefusedError(
          "error",
          `stackexchange search failed: search/excerpts answered ${String(response.status)}.`,
        );
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(response.body);
      } catch {
        throw new ProviderRefusedError("error", "stackexchange returned an unparseable body");
      }

      // Backoff constrains the next call; it does not invalidate these items.
      if (
        readsAsBackoffSeconds(parsed) &&
        Number.isSafeInteger(parsed.backoff * 1000) &&
        parsed.backoff > 0
      )
        io.onBackoff?.(parsed.backoff * 1000);

      if (!hasExcerptItems(parsed)) {
        throw new ProviderRefusedError("error", "stackexchange returned a malformed excerpts body");
      }

      const results: PublicSearchResult[] = [];
      for (const item of parsed.items) {
        if (results.length >= MAX_RESULTS) break;
        if (!isExcerptHit(item)) continue;
        if (typeof item.question_id !== "number" || !Number.isInteger(item.question_id)) continue;
        const excerpt = typeof item.excerpt === "string" ? item.excerpt : "";
        results.push({
          title: (typeof item.title === "string" ? item.title : "").trim().slice(0, TITLE_LIMIT),
          url: `https://stackoverflow.com/q/${String(item.question_id)}`,
          snippet: excerpt.replace(HIGHLIGHT_MARKUP, "").trim().slice(0, SNIPPET_LIMIT),
        });
      }
      return results;
    },
  };
}
