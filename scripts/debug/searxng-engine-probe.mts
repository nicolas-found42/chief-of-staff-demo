// Feedback loop for the "SearXNG contributes no results" bug (2026-09-18).
//
// It drives the exact request the app's provider makes
// (`apps/server/src/source-adapters/providers/searxng.ts`:
// `/search?q=<query>&format=json`) and fails when the instance answers zero
// results - the user-visible symptom, since a provider that returns [] is
// indistinguishable from "the web knows nothing about this person".
//
// Then it probes each candidate engine in isolation (`&engines=<id>`) so the
// per-engine verdict is separated from the merged one, and reports each
// engine's own `unresponsive_engines` reason.
//
// Usage:
//   pnpm exec tsx scripts/debug/searxng-engine-probe.mts [query]
//   SEARXNG_URL=http://127.0.0.1:8080 pnpm exec tsx scripts/debug/searxng-engine-probe.mts
// Exit 0 = the merged general query returned results; 1 = the bug reproduces.
const BASE = (process.env.SEARXNG_URL ?? "http://127.0.0.1:8080").replace(/\/+$/, "");
const QUERY = process.argv[2] ?? "Ethan Mollick Wharton";
const TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS ?? 25_000);
/** Engine ids probed one at a time. Stock-enabled general engines first, then
    the keyless candidates this instance could enable. An id that does not
    exist in this image's engine registry is NOT queried — confirmed live
    2026-09-18: `engines=<unknown-id>` does not error or return zero, it
    silently falls back to the full default merge, which looks exactly like
    a real per-engine answer. Candidates are checked against `/config`
    first and skipped, not queried, when absent. */
const CANDIDATES = [
  "brave",
  "duckduckgo",
  "google cse",
  "startpage",
  "wikipedia",
  "wikidata",
  "bing",
  "mwmbl",
  "yep",
  "wiby",
  "crossref",
  "openalex",
  "google",
  "duckduckgo web",
  "qwant",
  "seznam",
  "naver",
  "yandex",
  "yahoo",
  "baidu",
  "360search",
  "sogou",
  "quark",
  "crowdview",
  "fireball",
  "gmx",
  "privacywall",
  "tusksearch",
  "resulthunter",
  "searchtoday",
  "infospace",
  "mojeek",
  "swisscows",
];

type SearxngBody = {
  results?: unknown;
  unresponsive_engines?: unknown;
  number_of_results?: unknown;
};

async function realEngineNames(): Promise<Set<string>> {
  const response = await fetch(`${BASE}/config`);
  const config = (await response.json()) as { engines?: Array<{ name?: unknown }> };
  const names = (config.engines ?? [])
    .map((entry) => entry.name)
    .filter((name): name is string => typeof name === "string");
  return new Set(names);
}

async function ask(params: Record<string, string>): Promise<{
  status: number;
  results: number;
  unresponsive: string[];
  ms: number;
  body: string;
}> {
  const url = `${BASE}/search?${new URLSearchParams({ q: QUERY, format: "json", ...params })}`;
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const text = await response.text();
    const ms = Date.now() - started;
    if (response.status !== 200) {
      return {
        status: response.status,
        results: 0,
        unresponsive: [],
        ms,
        body: text.slice(0, 200),
      };
    }
    const parsed = JSON.parse(text) as SearxngBody;
    const results = Array.isArray(parsed.results) ? parsed.results.length : 0;
    const unresponsive = Array.isArray(parsed.unresponsive_engines)
      ? parsed.unresponsive_engines.map((entry) =>
          Array.isArray(entry) ? entry.map(String).join(": ") : String(entry),
        )
      : [];
    return { status: 200, results, unresponsive, ms, body: "" };
  } catch (error) {
    return {
      status: 0,
      results: 0,
      unresponsive: [],
      ms: Date.now() - started,
      body: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

console.log(`# SearXNG probe — ${BASE} — query ${JSON.stringify(QUERY)}`);

const merged = await ask({});
console.log(
  `\n## merged general query (what the app asks)\n` +
    `status ${merged.status} · ${merged.results} results · ${merged.ms}ms` +
    (merged.unresponsive.length ? `\nunresponsive: ${merged.unresponsive.join(" | ")}` : "") +
    (merged.body ? `\nbody: ${merged.body}` : ""),
);

console.log(`\n## per-engine (engines=<id>)`);
const registry = await realEngineNames();
const rows: string[] = [];
let skipped = 0;
for (const engine of CANDIDATES) {
  if (!registry.has(engine)) {
    skipped += 1;
    rows.push(`${engine.padEnd(18)}   -- skipped: not a real engine id in this image`);
    console.log(rows.at(-1));
    continue;
  }
  const one = await ask({ engines: engine });
  const reason = one.unresponsive.length ? one.unresponsive.join(" | ") : one.body || "";
  rows.push(
    `${engine.padEnd(18)} ${String(one.results).padStart(3)} results  ${String(one.ms).padStart(6)}ms  ${reason}`,
  );
  console.log(rows.at(-1));
}

const queried = CANDIDATES.length - skipped;
const answering = rows.filter((row) => /results/.test(row) && !/\s{2}0 results/.test(row)).length;
console.log(
  `\n## verdict\nmerged: ${merged.results} results · engines answering alone: ${answering}/${queried} queried (${skipped} skipped: not real engine ids)`,
);

if (merged.results === 0) {
  console.error(`\nFAIL: the app's own request shape returned 0 results — the bug reproduces.`);
  process.exit(1);
}
console.log(`\nPASS: the app's own request shape returned ${merged.results} results.`);
