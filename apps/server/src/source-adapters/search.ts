import { publicHttpFetch, type PublicHttpFetch } from "./http.js";
import { defaultProviders } from "./providers/index.js";
import { fetchSuggestions } from "./providers/suggest.js";
import { ProviderRefusedError, type SearchProviderIo } from "./providers/types.js";

export interface PublicSearchResult {
  title: string;
  url: string;
  snippet: string;
}

/**
 * Public search over independent keyless sources — the same posture the rest
 * of the app collects with: no login, no imported cookies, no key. People
 * Discovery uses it to find who is being named alongside the people already
 * watched (spec #116 story 21); Meeting Brief Generator and Person Profiles
 * ask it for public evidence about one person. The question asked is the
 * caller's, never this seam's.
 */
export type PublicSearch = (query: string) => Promise<PublicSearchResult[]>;

/** The search route refused to answer — distinct from answering with nothing. */
export class PublicSearchUnavailableError extends Error {
  readonly code = "public-search-unavailable";
}

/** The anonymous HTML route this seam searched before the provider bundle. */
export const PUBLIC_SEARCH_ROUTE = "https://html.duckduckgo.com/html/";

/**
 * One line per provider per pass: what it answered, how long it took, and why
 * it refused. This is the operator's view of a fan-out whose failures are
 * per-source and silent by design.
 */
export type PublicSearchDiagnosticEvent = {
  provider: string;
  query: string;
  outcome: "ok" | "empty" | "refused" | "cooldown" | "cached" | "expanded";
  results: number;
  ms: number;
  detail?: string;
};

export type PublicSearchDiagnostics = (event: PublicSearchDiagnosticEvent) => void;

/** The composite's per-request deadline; slow sources (GDELT, Wayback) override it. */
const IO_TIMEOUT_MS = 20_000;

/**
 * The merged result ceiling.
 *
 * Raised with the source-family expansion (#228): with thirty-odd providers
 * answering, a 24-result ceiling filled from the top of a registration-ordered
 * list discarded whole families before anything could look at them.
 */
const MERGED_LIMIT = 60;

/** How long a rate-limited provider rests when it sends no Retry-After. */
const RATE_LIMIT_COOLDOWN_MS = 3_600_000;

const CAPTCHA_COOLDOWN_MS = 86_400_000;

const CACHE_TTL_MS = 600_000;

/* The provider contract pins exactly two providers that decline a query
   without a request: Wayback answers [] for a query that is not an absolute
   URL, and Arctic Shift for a query without an r/ or u/ scope. A decline is
   the provider saying "this question is not mine" — neither an answer nor a
   refusal — so an all-refused pass stays all-refused even while these two
   sit the query out. */
const DECLINES_WITHOUT_REQUEST = new Set(["wayback", "arctic-shift", "nppes"]);

export function createPublicSearch(
  fetchText: PublicHttpFetch = publicHttpFetch,
  endpoint?: (query: string) => string,
  options: {
    diagnostics?: PublicSearchDiagnostics;
    searxngUrl?: string;
    now?: () => number;
    cacheTtlMs?: number;
    /**
     * Which providers this instance may ask. The app-wide instance asks all of
     * them; the benchmark's incumbent baseline uses this to reconstruct the
     * bundle as it stood before the #228 source expansion, so a comparison can
     * name the provider set as one of its recorded conditions.
     */
    providerFilter?: (name: string) => boolean;
    /** Override the merged ceiling. Same reason as `providerFilter`. */
    mergedLimit?: number;
  } = {},
): PublicSearch {
  const bundleOptions: {
    fetch?: PublicHttpFetch;
    searxngUrl?: string;
    endpoint?: (query: string) => string;
  } = {};
  if (fetchText !== publicHttpFetch) bundleOptions.fetch = fetchText;
  if (options.searxngUrl !== undefined) bundleOptions.searxngUrl = options.searxngUrl;
  if (endpoint !== undefined) bundleOptions.endpoint = endpoint;
  const providers = options.providerFilter
    ? defaultProviders(bundleOptions).filter((provider) => options.providerFilter!(provider.name))
    : defaultProviders(bundleOptions);
  const mergedLimit = options.mergedLimit ?? MERGED_LIMIT;
  const now = options.now ?? (() => Date.now());
  const cacheTtlMs = options.cacheTtlMs ?? CACHE_TTL_MS;
  const diagnostics = options.diagnostics;

  /* State lives per instance: results by exact query, and per-provider
     cooldowns — a refused provider rests instead of being retried, because
     retrying a rate limit is how an hour ban becomes a day ban. */
  const cache = new Map<string, { at: number; results: PublicSearchResult[] }>();
  const cooldownUntil = new Map<string, number>();
  const expandedQueries = new Set<string>();

  function refuse(
    provider: string,
    query: string,
    ms: number,
    error: ProviderRefusedError,
  ): ProviderRefusedError {
    if (error.reason === "rate-limited") {
      cooldownUntil.set(
        provider,
        now() + Math.max(error.retryAfterMs ?? 0, RATE_LIMIT_COOLDOWN_MS),
      );
    } else if (error.reason === "captcha") {
      cooldownUntil.set(provider, now() + CAPTCHA_COOLDOWN_MS);
    }
    diagnostics?.({
      provider,
      query,
      outcome: "refused",
      results: 0,
      ms,
      detail: error.message,
    });
    return error;
  }

  /** One fan-out over the whole bundle: merge in registration order, dedupe
      by exact URL keeping the first, cap the merge. A provider is "engaged"
      when it answered or refused; cooldown-skipped providers and providers
      that declined the query count as neither. */
  async function runPass(
    query: string,
    answeredOutcome: "ok" | "expanded",
  ): Promise<{
    merged: PublicSearchResult[];
    answered: number;
    engaged: number;
    refused: number;
    refusals: string[];
  }> {
    const refusals: string[] = [];
    const merged: PublicSearchResult[] = [];
    /* Per-provider slots: the merge runs after the fan-out settles, so results
       land in registration order regardless of which provider answered first —
       the pinned order decides which provider's duplicate survives dedupe. */
    const perProvider: PublicSearchResult[][] = Array.from({ length: providers.length }, () => []);
    let answered = 0;
    let engaged = 0;
    let refused = 0;

    const io: SearchProviderIo = { fetch: fetchText, timeoutMs: IO_TIMEOUT_MS };

    await Promise.all(
      providers.map(async (provider, index) => {
        const startedAt = now();
        const until = cooldownUntil.get(provider.name);
        if (until !== undefined && until > startedAt) {
          diagnostics?.({
            provider: provider.name,
            query,
            outcome: "cooldown",
            results: 0,
            ms: 0,
            detail: `resting for another ${until - startedAt}ms`,
          });
          return;
        }
        try {
          const found = await provider.search(query, io);
          const ms = now() - startedAt;
          if (found.length === 0 && DECLINES_WITHOUT_REQUEST.has(provider.name)) {
            diagnostics?.({ provider: provider.name, query, outcome: "empty", results: 0, ms });
            return;
          }
          engaged += 1;
          answered += 1;
          diagnostics?.({
            provider: provider.name,
            query,
            outcome: found.length > 0 ? answeredOutcome : "empty",
            results: found.length,
            ms,
          });
          perProvider[index] = found;
        } catch (error) {
          const ms = now() - startedAt;
          /* Any throw that is not a refusal is a broken provider, not a
             search result: it refuses as "error" so one malformed body never
             fails the whole query. */
          engaged += 1;
          refused += 1;
          const classified = refuse(
            provider.name,
            query,
            ms,
            error instanceof ProviderRefusedError
              ? error
              : new ProviderRefusedError("error", String(error)),
          );
          refusals.push(`${provider.name}: ${classified.reason}`);
        }
      }),
    );
    /* Round-robin across providers rather than draining each in turn: the
       merge is capped, and taking every result from the first provider before
       looking at the last one is registration-order truncation wearing a
       different hat (#228). Registration order still decides ties, so it still
       decides which provider's duplicate survives dedupe (ADR-0049). */
    const seen = new Set<string>();
    const depth = Math.max(0, ...perProvider.map((found) => found.length));
    for (let index = 0; index < depth; index += 1) {
      for (const found of perProvider) {
        const result = found[index];
        if (!result || seen.has(result.url)) continue;
        seen.add(result.url);
        merged.push(result);
      }
    }

    return {
      merged: merged.slice(0, mergedLimit),
      answered,
      engaged,
      refused,
      refusals,
    };
  }

  return async (query) => {
    const cached = cache.get(query);
    if (cached) {
      if (now() - cached.at < cacheTtlMs) {
        diagnostics?.({
          provider: "cache",
          query,
          outcome: "cached",
          results: cached.results.length,
          ms: 0,
        });
        return cached.results;
      }
      cache.delete(query);
    }

    const pass = await runPass(query, "ok");
    if (pass.engaged > 0 && pass.refused === pass.engaged) {
      /* A search where every provider refused is evidence of nothing at all,
         so it must not read as "the person has no public footprint". */
      throw new PublicSearchUnavailableError(
        `Public search is unavailable: all ${String(pass.engaged)} providers refused ` +
          `(${pass.refusals.join("; ")}).`,
      );
    }

    let merged = pass.merged;
    /* Second-chance expansion: a cleanly empty pass may have asked the wrong
       question. Ask the suggest endpoints for variants and run the bundle
       once per variant — a multiplier, never a dependency, so its failures
       are swallowed wholesale, and each query is expanded at most once. */
    if (
      merged.length === 0 &&
      pass.answered > 0 &&
      pass.refused === 0 &&
      !expandedQueries.has(query)
    ) {
      expandedQueries.add(query);
      const variants = await fetchSuggestions(query, {
        fetch: fetchText,
        timeoutMs: IO_TIMEOUT_MS,
      })
        .then((suggestions) => suggestions.filter((variant) => variant !== query).slice(0, 2))
        .catch(() => [] as string[]);
      const seen = new Set(merged.map((result) => result.url));
      for (const variant of variants) {
        const expansion = await runPass(variant, "expanded");
        for (const result of expansion.merged) {
          if (seen.has(result.url)) continue;
          seen.add(result.url);
          merged.push(result);
        }
      }
      merged = merged.slice(0, mergedLimit);
    }

    /* Only successes are cached — a refusal cached here would report "no
       public footprint" for an hour after the network recovered. */
    cache.set(query, { at: now(), results: merged });
    return merged;
  };
}
