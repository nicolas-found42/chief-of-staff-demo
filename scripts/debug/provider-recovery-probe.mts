// One bounded live request per public-search provider through the real
// guarded transport. This is the "one purposeful request through this
// adapter with `Richard Achee`" acceptance check recorded on issues
// #424/#426-#442: one call each, no retries, sequential dispatch, honest
// capture of status, shape and timings. Not a campaign; never use this to
// force a pass by repeating failures.
//
// Usage: pnpm exec tsx scripts/debug/provider-recovery-probe.mts [provider ...]
import { publicHttpFetch } from "../../apps/server/src/source-adapters/http.js";
import type { SearchProvider } from "../../apps/server/src/source-adapters/providers/types.js";
import { ProviderRefusedError } from "../../apps/server/src/source-adapters/providers/types.js";
import { createDuckDuckGoProvider } from "../../apps/server/src/source-adapters/providers/duckduckgo.js";
import { createDblpProvider } from "../../apps/server/src/source-adapters/providers/dblp.js";
import { createEdgarProvider } from "../../apps/server/src/source-adapters/providers/edgar.js";
import { createGdeltProvider } from "../../apps/server/src/source-adapters/providers/gdelt.js";
import { createGitHubUsersProvider } from "../../apps/server/src/source-adapters/providers/github-users.js";
import { createInternetArchiveProvider } from "../../apps/server/src/source-adapters/providers/ia-advancedsearch.js";
import { createIaTvNewsProvider } from "../../apps/server/src/source-adapters/providers/ia-tvnews.js";
import { createMarginaliaProvider } from "../../apps/server/src/source-adapters/providers/marginalia.js";
import { createMojeekProvider } from "../../apps/server/src/source-adapters/providers/mojeek.js";
import { createOpenAlexProvider } from "../../apps/server/src/source-adapters/providers/openalex.js";
import { createRedditRssProvider } from "../../apps/server/src/source-adapters/providers/reddit-rss.js";
import { createStackExchangeProvider } from "../../apps/server/src/source-adapters/providers/stackexchange.js";
import { createWibyProvider } from "../../apps/server/src/source-adapters/providers/wiby.js";
import { createWikipediaProvider } from "../../apps/server/src/source-adapters/providers/wikipedia.js";
import {
  createCrossrefProvider,
  createLibraryOfCongressProvider,
} from "../../apps/server/src/source-adapters/providers/person-records.js";
import { createMwmblProvider } from "../../apps/server/src/source-adapters/providers/person-media.js";

const QUERY = "Richard Achee";
const TIMEOUT_MS = 20_000;
const GAP_MS = 1_500;

type ProbeOutcome = {
  provider: string;
  issue: number;
  query: string;
  at: string;
  outcome: "ok" | "refused" | "error";
  elapsedMs: number;
  /** Wait a successful response asked for before later calls (#422 contract). */
  backoffMs?: number;
  results?: { count: number; firstTitle?: string; firstUrl?: string };
  refusal?: { reason: string; message: string; retryAfterMs?: number };
  error?: string;
};

const registry: Array<{ name: string; issue: number; create: () => SearchProvider }> = [
  { name: "wikipedia", issue: 432, create: createWikipediaProvider },
  { name: "stackexchange", issue: 424, create: createStackExchangeProvider },
  { name: "dblp", issue: 426, create: createDblpProvider },
  { name: "mojeek", issue: 427, create: createMojeekProvider },
  { name: "marginalia", issue: 428, create: createMarginaliaProvider },
  { name: "gdelt", issue: 429, create: createGdeltProvider },
  { name: "openalex", issue: 430, create: createOpenAlexProvider },
  { name: "duckduckgo", issue: 431, create: createDuckDuckGoProvider },
  { name: "reddit-rss", issue: 434, create: createRedditRssProvider },
  { name: "internet-archive", issue: 435, create: createInternetArchiveProvider },
  { name: "ia-tvnews", issue: 436, create: createIaTvNewsProvider },
  { name: "wiby", issue: 437, create: createWibyProvider },
  { name: "github-users", issue: 438, create: createGitHubUsersProvider },
  { name: "edgar", issue: 439, create: createEdgarProvider },
  { name: "mwmbl", issue: 440, create: createMwmblProvider },
  { name: "crossref", issue: 441, create: createCrossrefProvider },
  { name: "library-of-congress", issue: 442, create: createLibraryOfCongressProvider },
];

const wanted = process.argv.slice(2);
const selected = wanted.length ? registry.filter((e) => wanted.includes(e.name)) : registry;
const unknown = wanted.filter((n) => !registry.some((e) => e.name === n));
if (unknown.length) {
  console.error(`unknown providers: ${unknown.join(", ")}`);
  process.exit(2);
}

const outcomes: ProbeOutcome[] = [];
for (const entry of selected) {
  const provider = entry.create();
  const startedAt = Date.now();
  const outcome: ProbeOutcome = {
    provider: entry.name,
    issue: entry.issue,
    query: QUERY,
    at: new Date().toISOString(),
    outcome: "error",
    elapsedMs: 0,
  };
  let backoffMs: number | undefined;
  try {
    const results = await provider.search(QUERY, {
      fetch: publicHttpFetch,
      timeoutMs: TIMEOUT_MS,
      onBackoff: (milliseconds) => {
        backoffMs = milliseconds;
      },
    });
    outcome.outcome = "ok";
    const first = results[0];
    outcome.results = {
      count: results.length,
      ...(first ? { firstTitle: first.title.slice(0, 120), firstUrl: first.url } : {}),
    };
    if (backoffMs !== undefined) outcome.backoffMs = backoffMs;
  } catch (error) {
    if (error instanceof ProviderRefusedError) {
      outcome.outcome = "refused";
      outcome.refusal = {
        reason: error.reason,
        message: error.message,
        ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
      };
    } else {
      outcome.outcome = "error";
      outcome.error = error instanceof Error ? error.message : String(error);
    }
  }
  outcome.elapsedMs = Date.now() - startedAt;
  outcomes.push(outcome);
  console.log(JSON.stringify(outcome));
  if (entry !== selected[selected.length - 1]) {
    await new Promise((resolve) => setTimeout(resolve, GAP_MS));
  }
}
