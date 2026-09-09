import { describe, expect, it } from "vitest";
import {
  createPublicSearch,
  SEARCH_PASS_SOFT_DEADLINE_MS,
  SEARCH_PASS_SETTLE_FRACTION,
  type PublicSearchDiagnosticEvent,
} from "../../../apps/server/src/source-adapters/search";
import type {
  PublicHttpFetch,
  PublicHttpResponse,
} from "../../../apps/server/src/source-adapters/http";

/**
 * Hermetic soft-pass-deadline tests: the bundle is narrowed to three
 * providers (two fast, one delayable straggler) so the fan-out timing is
 * fully controlled. The 10s straggler mirrors the task's acceptance shape —
 * slow enough that only the deadline (never luck) can beat it, fast enough
 * to land before the 20s per-provider transport deadline.
 *
 * Real-timer exception (repo timers rule): this lever IS wall-clock
 * scheduling — a setTimeout deadline racing genuine provider latency —
 * against the real transport-timeout plumbing it must not disturb. Fake
 * timers would require reimplementing the scheduler interleaving by hand and
 * prove nothing about the race itself, so the straggler uses genuine
 * delays. Wherever the code emits a real signal (the late diagnostic event),
 * the test awaits that signal instead of guessing a duration.
 */

const FILTER = ["duckduckgo", "wikipedia", "openalex"];
const providerFilter = (name: string): boolean => FILTER.includes(name);

const STRAGGLER_HOST = "api.openalex.org";
const STRAGGLER_DELAY_MS = 10_000;

const sleep = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

/**
 * Await the straggler's late diagnostic event — the real signal that its
 * results landed — instead of guessing how long the tail takes. Bounded so
 * a lost result fails loudly instead of hanging the file.
 */
async function waitForLateResult(
  events: PublicSearchDiagnosticEvent[],
  query: string,
  timeoutMs = 15_000,
): Promise<PublicSearchDiagnosticEvent[]> {
  const startedAt = Date.now();
  for (;;) {
    const late = events.filter(
      (event) => event.late === true && event.provider === "openalex" && event.query === query,
    );
    if (late.length > 0 || Date.now() - startedAt > timeoutMs) return late;
    await sleep(100);
  }
}

function respond(url: string, status: number, body: string): PublicHttpResponse {
  return {
    url,
    status,
    contentType: "text/html",
    etag: null,
    lastModified: null,
    retryAfter: null,
    body,
  };
}

function ddgHtml(results: Array<{ title: string; url: string }>): string {
  return results
    .map(
      (result) =>
        `<div class="result"><a class="result__a" href="${result.url}">${result.title}</a></div>`,
    )
    .join("");
}

/** The MediaWiki opensearch positional array: [query, titles, snippets, urls]. */
function wikiBody(results: Array<{ title: string; snippet: string; url: string }>): string {
  return JSON.stringify([
    "",
    results.map((result) => result.title),
    results.map((result) => result.snippet),
    results.map((result) => result.url),
  ]);
}

function openAlexBody(results: Array<{ name: string; id: string }>): string {
  return JSON.stringify({
    results: results.map((result) => ({ id: result.id, display_name: result.name })),
  });
}

/**
 * Fake transport with per-host delays. `delays` is read per request so tests
 * can arm the straggler between passes on the same instance.
 */
function makeFetch(delays: Record<string, number>): { fetch: PublicHttpFetch } {
  const fetch: PublicHttpFetch = async (url) => {
    const host = new URL(url).host;
    const delay = delays[host] ?? 0;
    if (delay > 0) await sleep(delay);
    if (host === "html.duckduckgo.com")
      return respond(
        url,
        200,
        ddgHtml([{ title: "Fast DDG Person", url: "https://example.com/ddg-person" }]),
      );
    if (host === "en.wikipedia.org")
      return respond(
        url,
        200,
        wikiBody([
          {
            title: "Fast Wiki Person",
            snippet: "A fast person",
            url: "https://en.wikipedia.org/wiki/Fast_Person",
          },
        ]),
      );
    if (host === STRAGGLER_HOST)
      return respond(
        url,
        200,
        openAlexBody([{ name: "Straggler Scholar", id: "https://openalex.org/A123" }]),
      );
    return respond(url, 500, "unexpected host");
  };
  return { fetch };
}

function captureDiagnostics(): {
  events: PublicSearchDiagnosticEvent[];
  diagnostics: (event: PublicSearchDiagnosticEvent) => void;
} {
  const events: PublicSearchDiagnosticEvent[] = [];
  return {
    events,
    diagnostics: (event) => {
      events.push(event);
    },
  };
}

const hasProvider = (results: Array<{ upstreamIndex?: string }>, name: string): boolean =>
  results.some((result) => result.upstreamIndex === name);

describe("the PublicSearch soft pass deadline", () => {
  it("waits for every provider on the first pass even past the soft deadline", async () => {
    const { fetch } = makeFetch({ [STRAGGLER_HOST]: STRAGGLER_DELAY_MS });
    const { events, diagnostics } = captureDiagnostics();
    const search = createPublicSearch(fetch, undefined, {
      diagnostics,
      providerFilter,
      passSoftDeadlineMs: 250,
    });

    const startedAt = Date.now();
    const results = await search("seed coverage query");
    const elapsed = Date.now() - startedAt;

    // The exempt first pass paid the full 10s tail: the straggler answered.
    expect(hasProvider(results, "openalex")).toBe(true);
    expect(hasProvider(results, "wikipedia")).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(9000);
    // Nothing was cut on an exempt pass.
    expect(events.some((event) => event.cut === true)).toBe(false);
  }, 30_000);

  it("cuts the straggler on a later pass, records the cut, and merges its late results", async () => {
    const delays: Record<string, number> = {};
    const { fetch } = makeFetch(delays);
    const { events, diagnostics } = captureDiagnostics();
    const search = createPublicSearch(fetch, undefined, {
      diagnostics,
      providerFilter,
      passSoftDeadlineMs: 250,
    });

    // First pass (exempt): everything fast, establishes seed coverage.
    const seed = await search("seed query");
    expect(hasProvider(seed, "openalex")).toBe(true);

    // Later pass with a 10s straggler. Three providers at the default 0.8
    // settle fraction need all three to settle, so the threshold cannot fire
    // and only the soft deadline resolves this pass.
    delays[STRAGGLER_HOST] = STRAGGLER_DELAY_MS;
    const startedAt = Date.now();
    const cut = await search("straggler query");
    const elapsed = Date.now() - startedAt;

    // (a) The pass resolved at the soft deadline without the straggler: it
    // waited for the 250ms deadline (not an instant threshold resolve) yet
    // finished far below the 10s tail — and below the 8s production default,
    // proving the injectable override took effect.
    expect(elapsed).toBeGreaterThanOrEqual(150);
    expect(elapsed).toBeLessThan(5000);
    expect(elapsed).toBeLessThan(SEARCH_PASS_SOFT_DEADLINE_MS);
    expect(hasProvider(cut, "wikipedia")).toBe(true);
    expect(hasProvider(cut, "openalex")).toBe(false);

    // (d) The diagnostic records which provider was cut this pass.
    const cuts = events.filter((event) => event.cut === true && event.query === "straggler query");
    expect(cuts).toHaveLength(1);
    expect(cuts[0]).toMatchObject({
      provider: "openalex",
      outcome: "empty",
      results: 0,
      cut: true,
    });

    // (b) The straggler still lands before its 20s transport deadline and its
    // results merge into the shared pool: a repeat query reads them from the
    // patched cache entry.
    const late = await waitForLateResult(events, "straggler query");
    expect(late.some((event) => event.outcome === "ok" && event.results === 1)).toBe(true);
    const reread = await search("straggler query");
    expect(hasProvider(reread, "openalex")).toBe(true);
    expect(hasProvider(reread, "wikipedia")).toBe(true);
  }, 30_000);

  it("resolves a later pass once most providers settle without waiting for the deadline", async () => {
    // The default fraction means "most": a strict majority of the bundle.
    expect(SEARCH_PASS_SETTLE_FRACTION).toBeGreaterThan(0.5);
    const delays: Record<string, number> = {};
    const { fetch } = makeFetch(delays);
    const { events, diagnostics } = captureDiagnostics();
    const search = createPublicSearch(fetch, undefined, {
      diagnostics,
      providerFilter,
      passSoftDeadlineMs: 30_000,
      // Three providers at 0.34 need ceil(1.02) = 2 to settle.
      passSettleFraction: 0.34,
    });

    await search("seed query");

    // Later pass: two fast providers settle immediately while the third is
    // 3s out, so the settle threshold — not the 30s deadline — resolves it.
    delays[STRAGGLER_HOST] = 3000;
    const startedAt = Date.now();
    const resolved = await search("threshold query");
    const elapsed = Date.now() - startedAt;

    expect(hasProvider(resolved, "wikipedia")).toBe(true);
    expect(hasProvider(resolved, "openalex")).toBe(false);
    expect(elapsed).toBeLessThan(2000);
    // The threshold path still cuts and records the unsettled provider; its
    // late results merge afterwards like any other cut.
    expect(
      events.some(
        (event) =>
          event.cut === true && event.provider === "openalex" && event.query === "threshold query",
      ),
    ).toBe(true);
  }, 30_000);
});
