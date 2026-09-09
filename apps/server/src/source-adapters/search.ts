import { loadRorIndex } from "./ror-index.js";
import { canonicalSourceUrl } from "./source-identity.js";
import { publicHttpFetch, type PublicHttpFetch } from "./http.js";
import { defaultProviders } from "./providers/index.js";
import { fetchSuggestions } from "./providers/suggest.js";
import { ProviderRefusedError, type SearchProviderIo } from "./providers/types.js";

export interface PublicSearchResult {
  title: string;
  url: string;
  snippet: string;
  /** Original index and discovered URL remain available after canonicalization. */
  upstreamIndex?: string;
  sourceVersion?: string;
  discoveryUrl?: string;
  discoveryUrls?: string[];
  entityType?: "person" | "organization" | "artifact" | "page";
}

/**
 * Public search over independent keyless sources — the same posture the rest
 * of the app collects with: no login, no imported cookies, no key. People
 * Discovery uses it to find who is being named alongside the people already
 * watched (spec #116 story 21); Meeting Brief Generator and Person Profiles
 * ask it for public evidence about one person. The question asked is the
 * caller's, never this seam's.
 */
interface DiscoveryIntent {
  fullName?: string | null;
  organizations?: string[];
  emails?: string[];
  coverage?: string[];
  language?: string;
}
export type PublicSearch = (
  query: string,
  intent?: DiscoveryIntent,
) => Promise<PublicSearchResult[]>;

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
  /**
   * The soft pass deadline cut this provider before it settled: it
   * contributed nothing to this pass's merge but keeps running, and a later
   * event with `late: true` records whether its results still landed.
   */
  cut?: boolean;
  /** This event describes a provider that settled after its pass resolved. */
  late?: boolean;
};

export type PublicSearchDiagnostics = (event: PublicSearchDiagnosticEvent) => void;

/** The composite's per-request deadline; slow sources (GDELT, Wayback) override it. */
const IO_TIMEOUT_MS = 20_000;
/**
 * Soft pass deadline (ADR-0076 speed lever): a non-exempt pass resolves its
 * merge once most providers have settled or this long after the pass
 * started, whichever comes first. Cut providers keep running in the
 * background and their results still merge into the shared pool — the
 * deadline defers slow results by a round, it never drops them. With 11–36
 * discovery rounds per operation, each round stops paying the slowest
 * straggler. Recorded in researchSettings conditions; injectable per
 * instance via `passSoftDeadlineMs` for hermetic tests.
 */
export const SEARCH_PASS_SOFT_DEADLINE_MS = 8_000;
/**
 * Fraction of the bundle that must settle before a non-exempt pass resolves
 * early without waiting for the soft deadline. Cooldown-skipped, declined,
 * and cache-hit providers settle immediately, so this counts finished
 * provider tasks, not just answered ones.
 */
export const SEARCH_PASS_SETTLE_FRACTION = 0.8;

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
    /** Optional explicit local ROR dump; absent uses the anonymous network route. */
    rorDataPath?: string;
    rorIndex?: ReturnType<typeof loadRorIndex>;
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
    /**
     * Override the soft pass deadline for hermetic tests. Production uses
     * `SEARCH_PASS_SOFT_DEADLINE_MS`.
     */
    passSoftDeadlineMs?: number;
    /**
     * Override the early-resolve settle fraction for hermetic tests.
     * Production uses `SEARCH_PASS_SETTLE_FRACTION`.
     */
    passSettleFraction?: number;
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
  const rorPath = options.rorDataPath ?? process.env.PERSON_RESEARCH_ROR_DATA;
  const rorIndex = options.rorIndex ?? (rorPath ? loadRorIndex(rorPath) : null);
  const mergedLimit = options.mergedLimit ?? MERGED_LIMIT;
  const now = options.now ?? (() => Date.now());
  const cacheTtlMs = options.cacheTtlMs ?? CACHE_TTL_MS;
  const diagnostics = options.diagnostics;
  const passSoftDeadlineMs = options.passSoftDeadlineMs ?? SEARCH_PASS_SOFT_DEADLINE_MS;
  const passSettleFraction = options.passSettleFraction ?? SEARCH_PASS_SETTLE_FRACTION;
  /* Pass serial for the soft-deadline exemption: the instance's first pass is
    the seed-coverage pass and always waits for every provider. The exemption
    is per instance, and the benchmark and production compositions share one
    search across every operation in the run (pipelines.ts constructs it
    once), so "first" means the run's first pass. Later operations' seed
    rounds run under the deadline; their cut providers' results still merge
    into the pool a round later — deferred, never dropped. */
  let passSerial = 0;

  /* State lives per instance: results by exact query, and per-provider
     cooldowns — a refused provider rests instead of being retried, because
     retrying a rate limit is how an hour ban becomes a day ban. */
  const cache = new Map<string, { at: number; results: PublicSearchResult[] }>();
  const cooldownUntil = new Map<string, number>();
  const expandedQueries = new Set<string>();
  const providerCache = new Map<string, { at: number; results: PublicSearchResult[] }>();
  const inFlight = new Map<string, Promise<PublicSearchResult[]>>();

  function refuse(
    provider: string,
    query: string,
    ms: number,
    error: ProviderRefusedError,
    report: PublicSearchDiagnostics | undefined = diagnostics,
  ): ProviderRefusedError {
    if (error.reason === "rate-limited") {
      cooldownUntil.set(
        provider,
        now() + Math.max(error.retryAfterMs ?? 0, RATE_LIMIT_COOLDOWN_MS),
      );
    } else if (error.reason === "captcha") {
      cooldownUntil.set(provider, now() + CAPTCHA_COOLDOWN_MS);
    }
    report?.({
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
      that declined the query count as neither. The instance's first pass
      awaits every provider; later passes resolve the merge on the settle
      threshold or the soft deadline while cut providers keep running and
      re-merge late through `onLateMerge`. */
  async function runPass(
    query: string,
    answeredOutcome: "ok" | "expanded",
    intent?: DiscoveryIntent,
    onLateMerge?: (merged: PublicSearchResult[]) => void,
  ): Promise<{
    merged: PublicSearchResult[];
    answered: number;
    engaged: number;
    refused: number;
    refusals: string[];
  }> {
    /* The first pass is exempt so seed coverage is complete. Later passes
       stop paying the slowest straggler every round: the merge resolves once
       the settle threshold or the soft deadline is reached, and whatever is
       still running merges opportunistically afterwards. Nothing is aborted
       on cut — each provider still answers or hits its own 20s transport
       deadline (the AbortController in http.ts), because SearchProviderIo
       carries no signal to cancel through; aborting here would drop results
       instead of deferring them by a round. */
    const exempt = passSerial === 0;
    passSerial += 1;
    const passStartedAt = now();
    const settleNeeded = Math.max(1, Math.ceil(providers.length * passSettleFraction));
    let settled = 0;
    let earlyResolved = false;
    let notifySettled: (() => void) | null = null;
    const settleGate = new Promise<void>((resolve) => {
      notifySettled = resolve;
    });
    const refusals: string[] = [];
    /* Per-provider slots: the merge runs after the fan-out settles, so results
       land in registration order regardless of which provider answered first —
       the pinned order decides which provider's duplicate survives dedupe. */
    const perProvider: PublicSearchResult[][] = Array.from({ length: providers.length }, () => []);
    const finished: boolean[] = Array.from({ length: providers.length }, () => false);
    let answered = 0;
    let engaged = 0;
    let refused = 0;

    const io: SearchProviderIo = { fetch: fetchText, timeoutMs: IO_TIMEOUT_MS };
    /* Diagnostics emitted after the early merge describe late arrivals, not
       pass-time answers. The cut events below bypass this wrapper so the cut
       itself is recorded promptly even when the provider never lands. */
    const emit: PublicSearchDiagnostics = (event) => {
      diagnostics?.(earlyResolved ? { ...event, late: true } : event);
    };

    /* Round-robin across providers rather than draining each in turn: the
       merge is capped, and taking every result from the first provider before
       looking at the last one is registration-order truncation wearing a
       different hat (#228). Registration order still decides ties, so it still
       decides which provider's duplicate survives dedupe (ADR-0049). The merge
       is recomputed from the slots for every late arrival, so the pool always
       reflects every provider that has settled so far. */
    const mergeProviders = (): PublicSearchResult[] => {
      const seen = new Map<string, PublicSearchResult>();
      const merged: PublicSearchResult[] = [];
      const depth = Math.max(0, ...perProvider.map((found) => found.length));
      for (let index = 0; index < depth; index += 1) {
        for (const found of perProvider) {
          const result = found[index];
          if (!result) continue;
          const url = canonicalSourceUrl(result.url);
          const previous = seen.get(url);
          if (previous) {
            previous.discoveryUrls = [
              ...new Set([
                ...(previous.discoveryUrls ?? [previous.discoveryUrl ?? previous.url]),
                result.url,
              ]),
            ].slice(0, 100);
            continue;
          }
          const normalized = {
            ...result,
            url,
            discoveryUrls: [result.url],
            ...(url !== result.url ? { discoveryUrl: result.url } : {}),
          };
          seen.set(url, normalized);
          merged.push(normalized);
        }
      }
      return merged.slice(0, mergedLimit);
    };

    const tasks = providers.map(async (provider, index) => {
      const startedAt = now();
      try {
        const until = cooldownUntil.get(provider.name);
        if (until !== undefined && until > startedAt) {
          emit({
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
          const nativeQuery = providerQuery(provider.name, query, intent);
          if (nativeQuery === null) return;
          const key = JSON.stringify([provider.name, nativeQuery]);
          const cached = providerCache.get(key);
          let found: PublicSearchResult[];
          if (cached && now() - cached.at < cacheTtlMs) found = cached.results;
          else {
            let work = inFlight.get(key);
            if (!work) {
              const local = provider.name === "ror" ? rorIndex?.lookup(nativeQuery) : null;
              work = local ? Promise.resolve(local) : provider.search(nativeQuery, io);
              inFlight.set(key, work);
            }
            try {
              found = await work;
              providerCache.set(key, { at: now(), results: found });
              if (providerCache.size > 2000)
                providerCache.delete(providerCache.keys().next().value!);
            } finally {
              if (inFlight.get(key) === work) inFlight.delete(key);
            }
          }
          const ms = now() - startedAt;
          if (found.length === 0 && DECLINES_WITHOUT_REQUEST.has(provider.name)) {
            emit({ provider: provider.name, query, outcome: "empty", results: 0, ms });
            return;
          }
          engaged += 1;
          answered += 1;
          emit({
            provider: provider.name,
            query,
            outcome: found.length > 0 ? answeredOutcome : "empty",
            results: found.length,
            ms,
          });
          perProvider[index] = found.map((result) => ({
            ...result,
            upstreamIndex: provider.name,
            entityType:
              provider.name === "ror"
                ? "organization"
                : provider.name === "orcid"
                  ? "person"
                  : provider.name === "artic"
                    ? "artifact"
                    : "page",
          }));
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
            emit,
          );
          refusals.push(`${provider.name}: ${classified.reason}`);
        }
      } finally {
        /* Every path counts as settled — cooldown skips and declines as well
           as answers and refusals — so the threshold never waits on a
           provider that already decided to sit the query out. */
        finished[index] = true;
        settled += 1;
        if (!exempt && settled >= settleNeeded) notifySettled?.();
        const slot = perProvider[index];
        if (earlyResolved && slot !== undefined && slot.length > 0) onLateMerge?.(mergeProviders());
      }
    });

    const deadlineTimer = exempt
      ? undefined
      : setTimeout(() => notifySettled?.(), passSoftDeadlineMs);
    if (exempt) {
      await Promise.all(tasks);
    } else {
      await Promise.race([Promise.all(tasks), settleGate]);
    }
    clearTimeout(deadlineTimer);

    if (!exempt) {
      const passMs = now() - passStartedAt;
      let cut = false;
      for (const [index, provider] of providers.entries()) {
        if (finished[index]) continue;
        cut = true;
        diagnostics?.({
          provider: provider.name,
          query,
          outcome: "empty",
          results: 0,
          ms: passMs,
          cut: true,
          detail:
            "cut by the soft pass deadline; still running in the background, " +
            "late results merge into the pool on arrival",
        });
      }
      if (cut) {
        earlyResolved = true;
        /* Late providers keep running after the early merge is served: observe
           them so a late throw (for example a diagnostics consumer throwing)
           never surfaces as an unhandled rejection after delivery. */
        void Promise.all(tasks).then(
          () => undefined,
          () => undefined,
        );
      }
    }

    return {
      merged: mergeProviders(),
      answered,
      engaged,
      refused,
      refusals,
    };
  }

  return async (query, intent) => {
    const cacheKey = JSON.stringify([query, intent]);
    const cached = cache.get(cacheKey);
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
      cache.delete(cacheKey);
    }

    /* Late providers from any pass of this query keep merging into the shared
       pool after the early merge is served: the cached entry is patched in
       place (within the merged ceiling), so a repeat query reads the cut
       provider's results once they land. Arrivals that land before the entry
       is written are replayed right after it. Each late merge is cumulative
       over its pass's settled providers, so replaying only the latest one
       loses nothing. The served array and the cached entry are the same
       reference, and late patches grow it in place. */
    const pendingLate = { results: null as PublicSearchResult[] | null };
    const patchPool = (fullMerged: PublicSearchResult[]): void => {
      const entry = cache.get(cacheKey);
      if (!entry) {
        pendingLate.results = fullMerged;
        return;
      }
      const seen = new Set(entry.results.map((result) => result.url));
      for (const result of fullMerged) {
        if (seen.has(result.url)) continue;
        if (entry.results.length >= mergedLimit) break;
        seen.add(result.url);
        entry.results.push(result);
      }
    };
    const onLateMerge = (fullMerged: PublicSearchResult[]): void => {
      patchPool(fullMerged);
    };

    const pass = await runPass(query, "ok", intent, onLateMerge);
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
        const expansion = await runPass(variant, "expanded", intent, onLateMerge);
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
    cache.set(cacheKey, { at: now(), results: merged });
    if (cache.size > 500) cache.delete(cache.keys().next().value!);
    if (pendingLate.results) {
      const late = pendingLate.results;
      pendingLate.results = null;
      patchPool(late);
    }
    return merged;
  };
}

/** Native entity queries avoid interpreting biography prose as a registry lookup. */
function providerQuery(provider: string, query: string, intent?: DiscoveryIntent): string | null {
  if (!intent) return query;
  const name = intent.fullName?.trim();
  if (provider === "ror") return intent.organizations?.find((name) => name.trim())?.trim() ?? null;
  if (provider === "artic") return name ?? null;
  if (provider !== "orcid") return query;
  if (!name) return null;
  const quote = (value: string) => `"${value.replace(/[\\"]/g, " ")}"`;
  const words = name.split(/\s+/);
  const fields =
    words.length > 1
      ? `(given-names:${quote(words.slice(0, -1).join(" "))} AND family-name:${quote(words.at(-1)!)}) OR `
      : "";
  return `${fields}credit-name:${quote(name)}`;
}
