import { createHash } from "node:crypto";
import { BlockList, isIP, type LookupFunction } from "node:net";
import CacheableLookup from "cacheable-lookup";
import { Agent, fetch as undiciFetch, type Dispatcher, type RequestInit } from "undici";
import { readSourceBytes, readSourceText } from "./source-body.js";

export interface PublicHttpResponse {
  url: string;
  status: number;
  contentType: string | null;
  etag: string | null;
  lastModified: string | null;
  retryAfter: string | null;
  body: string;
}

export type PublicHttpFetch = (
  url: string,
  options?: {
    etag?: string | null;
    lastModified?: string | null;
    timeoutMs?: number;
    method?: "POST";
    body?: string;
    /**
     * Override the accept header for one request. Several public record APIs
     * serve JSON only when asked for it and answer XML, 406 or 500 to the
     * default HTML-first list.
     */
    accept?: string;
  },
) => Promise<PublicHttpResponse>;
/** A stable browser-like UA for the documented HTML-scrape exceptions
 * (duckduckgo, mojeek — see docs/research/anti-bot-keyless-search.md). API
 * surfaces keep the descriptive default UA below. */
export const browserUserAgent =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

/* Public-source retrieval must apply one address policy to URL literals and
   the addresses actually handed to the socket. BlockList also recognizes
   IPv4-mapped IPv6, which string-prefix checks miss (SEC-01/02 in the
   2026-09-14 product experience audit). */
const nonPublicAddresses = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  nonPublicAddresses.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
  ["2001:db8::", 32],
] as const)
  nonPublicAddresses.addSubnet(address, prefix, "ipv6");

function nonPublicAddress(address: string): boolean {
  const family = isIP(address);
  return family === 0 || nonPublicAddresses.check(address, family === 4 ? "ipv4" : "ipv6");
}

function privateAddressError(): NodeJS.ErrnoException {
  return Object.assign(new Error("Source Targets must resolve to a public host."), {
    code: "ERR_SOURCE_PRIVATE_ADDRESS",
  });
}

export function assertPublicHttpUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Source Targets must use public HTTP or HTTPS URLs.");
  }
  const hostname = url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    (isIP(hostname) !== 0 && nonPublicAddress(hostname))
  ) {
    throw new Error("Source Targets must resolve to a public host.");
  }
  url.username = "";
  url.password = "";
  url.hash = "";
  return url;
}

/**
 * Connection-pool tuning for the collection transports below. Values follow
 * the production spelling proven by pnpm/gemini-cli/promptfoo (keep-alive
 * timeouts plus `connect.autoSelectFamily`); exported so the benchmark
 * conditions rows can name them.
 */
export const SOURCE_HTTP_KEEP_ALIVE_TIMEOUT_MS = 30_000;
const SOURCE_HTTP_KEEP_ALIVE_MAX_TIMEOUT_MS = 600_000;
export const SOURCE_HTTP_CONNECT_TIMEOUT_MS = 10_000;

/** The pooling dispatcher behind `createSourceHttpDispatcher`. */
export type SourceHttpDispatcher = Agent;

/**
 * Adapts a TTL-honoring `CacheableLookup` to the `LookupFunction` shape
 * `net.connect` expects. The overloads do not line up directly (numeric and
 * `"IPv4"`/`"IPv6"` families, plus the `all: true` Happy-Eyeballs form that
 * `autoSelectFamily` requests), so the narrows below are the contract, not
 * ceremony: unknown families fall back to family-agnostic resolution.
 */
function pooledLookup(lookup: CacheableLookup, guarded: boolean): LookupFunction {
  return (hostname, options, callback) => {
    const family = options.family === 4 || options.family === 6 ? options.family : undefined;
    const base: { hints?: number; family?: 4 | 6 } = {
      ...(typeof options.hints === "number" ? { hints: options.hints } : {}),
      ...(family === undefined ? {} : { family }),
    };
    if (options.all === true) {
      /* CacheableLookup calls back an error with no address list (ENOTFOUND
         and friends), and a successful `all` lookup's entries can be absent
         when the cache entry expired between the two callback paths — spread
         only what is actually an array, or the TypeError thrown here would
         crash the process from inside the connect path (live arm, 2026-09-09). */
      lookup.lookup(hostname, { ...base, all: true as const }, (error, result) => {
        /* Their declared callback type promises the address list on every
           path, but a resolver failure arrives with none (observed in the
           live arm 2026-09-09) — spreading it crashed the process from
           inside the connect path. An errored lookup is passed through
           untouched; only a resolved one is spread. */
        if (error) {
          callback(error, [], undefined);
          return;
        }
        if (guarded && result.some(({ address }) => nonPublicAddress(address))) {
          callback(privateAddressError(), [], undefined);
          return;
        }
        let family: number | undefined;
        for (const address of result) {
          family = address.family;
          break;
        }
        callback(error, [...result], family);
      });
    } else {
      lookup.lookup(hostname, base, (error, address, family) => {
        if (!error && guarded && nonPublicAddress(address)) {
          callback(privateAddressError(), "", family);
          return;
        }
        callback(error, address, family);
      });
    }
  };
}

/**
 * A pooling dispatcher for collection fetches. The hundreds of requests per
 * operation reuse keep-alive sockets instead of paying TCP+TLS setup per
 * host, and a TTL-honoring DNS cache replaces the per-request `getaddrinfo`
 * Node performs when no cache exists. Each call returns an isolated instance
 * so tests never share the process singleton; production transports share one
 * via `sharedSourceHttpDispatcher`.
 */
export function createSourceHttpDispatcher(guarded = true): SourceHttpDispatcher {
  const lookup = new CacheableLookup();
  return new Agent({
    keepAliveTimeout: SOURCE_HTTP_KEEP_ALIVE_TIMEOUT_MS,
    keepAliveMaxTimeout: SOURCE_HTTP_KEEP_ALIVE_MAX_TIMEOUT_MS,
    // Undici's default; stated so the no-pipelining choice reads as deliberate.
    pipelining: 1,
    connect: {
      timeout: SOURCE_HTTP_CONNECT_TIMEOUT_MS,
      autoSelectFamily: true,
      lookup: pooledLookup(lookup, guarded),
    },
  });
}

let sharedDispatcher: SourceHttpDispatcher | undefined;
let localSearchDispatcher: SourceHttpDispatcher | undefined;

/** The process-wide pooling dispatcher behind the default transports. */
function sharedSourceHttpDispatcher(guarded = true): SourceHttpDispatcher {
  if (!guarded) return (localSearchDispatcher ??= createSourceHttpDispatcher(false));
  sharedDispatcher ??= createSourceHttpDispatcher();
  return sharedDispatcher;
}

/* Only representation and body metadata survive an origin change. Provider
   headers are open-ended, so a list of known credential names would leak the
   next adapter's secret. Same-origin hops retain the caller's complete headers. */
const CROSS_ORIGIN_SOURCE_HEADERS = new Set([
  "accept",
  "accept-language",
  "user-agent",
  "content-type",
  "content-length",
]);

/** Validate each hop before fetch can open its socket, retaining one deadline.
 * Automatic redirects would bypass the URL policy. Cross-origin redirects
 * also must not carry provider-specific credentials or conditional headers. */
async function fetchSource(url: URL, init: RequestInit, guarded: boolean) {
  let current = url;
  let request = init;
  for (let redirects = 0; ; redirects += 1) {
    const response = await undiciFetch(current, { ...request, redirect: "manual" });
    const location = response.headers.get("location");
    if (![301, 302, 303, 307, 308].includes(response.status) || location === null)
      return { response, url: current.toString() };
    await response.body?.cancel();
    if (redirects >= 20) throw new Error("Source response exceeded the redirect limit.");
    const target = new URL(location, current);
    const next = guarded ? assertPublicHttpUrl(target.toString()) : target;
    const headers = new Headers(request.headers as HeadersInit);
    if (next.origin !== current.origin) {
      for (const name of [...headers.keys()]) {
        if (!CROSS_ORIGIN_SOURCE_HEADERS.has(name)) headers.delete(name);
      }
    }
    if (
      response.status === 303 ||
      ((response.status === 301 || response.status === 302) && request.method === "POST")
    ) {
      request = { ...request, method: "GET" };
      delete request.body;
      headers.delete("content-type");
      headers.delete("content-length");
    }
    request = { ...request, headers: Object.fromEntries(headers) };
    current = next;
  }
}

/**
 * The transports public collection and search fetch through. The default is
 * the guarded, 20-second, shared-UA fetch everything used while there was one
 * route; the options exist because the provider bundle (ADR-0049) needs
 * variants the guard cannot express — a declared contact UA (SEC EDGAR 403s
 * generic agents), an unguarded fetch for a fixed self-hosted SearXNG URL,
 * and longer deadlines for sources that answer slowly. A single request may
 * still override the deadline through `timeoutMs`.
 */
export function createHttpFetch(
  options: {
    timeoutMs?: number;
    headers?: Record<string, string>;
    guarded?: boolean;
    /**
     * Pooling dispatcher for the request. Defaults to the shared process
     * singleton; tests pass an isolated `createSourceHttpDispatcher()` agent.
     */
    dispatcher?: Dispatcher;
  } = {},
): PublicHttpFetch {
  const defaultTimeoutMs = options.timeoutMs ?? 20_000;
  const guarded = options.guarded ?? true;
  const dispatcher = options.dispatcher ?? sharedSourceHttpDispatcher(guarded);
  return async (value, perCall = {}) => {
    const url = guarded ? assertPublicHttpUrl(value) : new URL(value);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), perCall.timeoutMs ?? defaultTimeoutMs);
    try {
      const headers: Record<string, string> = {
        accept:
          "text/html, application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9",
        "user-agent": "Found42-Content-Scout/1.0 (+public-source-monitor)",
        ...options.headers,
      };
      if (perCall.accept) headers.accept = perCall.accept;
      if (perCall.etag) headers["if-none-match"] = perCall.etag;
      if (perCall.lastModified) headers["if-modified-since"] = perCall.lastModified;
      /* The collection transports call undici's own fetch export, not the
         global: attaching an npm-undici Agent as a per-request `dispatcher`
         on the global fetch fails with `invalid onRequestStart method` on
         runtimes whose built-in undici is a different major (Node 22 CI,
         2026-09-09). Undici's fetch and Agent from one module instance
         share the handler contract, so pooling works everywhere. Only
         these transports import undici's fetch — model calls stay on the
         global fetch with the default agent, and no global dispatcher is
         swapped. Tests intercept at the undici module boundary; the
         transport's guard, headers and timeout code still run. */
      const { response, url: finalUrl } = await fetchSource(
        url,
        {
          ...(perCall.method !== undefined ? { method: perCall.method } : {}),
          ...(perCall.body !== undefined ? { body: perCall.body } : {}),
          headers: perCall.body
            ? { ...headers, "content-type": "application/x-www-form-urlencoded" }
            : headers,
          signal: controller.signal,
          credentials: "omit",
          dispatcher,
        },
        guarded,
      );
      const body = await readSourceText(response.body);
      return {
        url: response.url || finalUrl,
        status: response.status,
        contentType: response.headers.get("content-type"),
        etag: response.headers.get("etag"),
        lastModified: response.headers.get("last-modified"),
        retryAfter: response.headers.get("retry-after"),
        body,
      };
    } finally {
      clearTimeout(timer);
    }
  };
}

export const publicHttpFetch: PublicHttpFetch = createHttpFetch();

export interface PublicHttpBytesResponse {
  url: string;
  status: number;
  contentType: string | null;
  retryAfter: string | null;
  bytes: Buffer;
}

export type PublicHttpBytesFetch = (
  url: string,
  options?: { timeoutMs?: number; accept?: string },
) => Promise<PublicHttpBytesResponse>;

/**
 * The same guarded anonymous transport, kept as bytes.
 *
 * Person research reads PDFs, scans and slide decks, and `PublicHttpFetch`
 * decodes every body as UTF-8 — which silently destroys exactly those. This is
 * the byte-preserving twin rather than a second transport policy: same public
 * URL guard, same anonymous credentials-omitted request, same 5 MB ceiling.
 */
function createHttpBytesFetch(
  options: { timeoutMs?: number; headers?: Record<string, string>; dispatcher?: Dispatcher } = {},
): PublicHttpBytesFetch {
  const defaultTimeoutMs = options.timeoutMs ?? 20_000;
  const dispatcher = options.dispatcher ?? sharedSourceHttpDispatcher();
  return async (value, perCall = {}) => {
    const url = assertPublicHttpUrl(value);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), perCall.timeoutMs ?? defaultTimeoutMs);
    try {
      const { response, url: finalUrl } = await fetchSource(
        url,
        {
          headers: {
            accept: perCall.accept ?? "application/pdf, application/octet-stream, */*;q=0.8",
            "user-agent": "Found42-Content-Scout/1.0 (+public-source-monitor)",
            ...options.headers,
          },
          signal: controller.signal,
          credentials: "omit",
          // Same pooled dispatcher as the text transport; see the note there.
          dispatcher,
        },
        true,
      );
      const bytes = await readSourceBytes(response.body);
      return {
        url: response.url || finalUrl,
        status: response.status,
        contentType: response.headers.get("content-type"),
        retryAfter: response.headers.get("retry-after"),
        bytes,
      };
    } finally {
      clearTimeout(timer);
    }
  };
}

export const publicHttpFetchBytes: PublicHttpBytesFetch = createHttpBytesFetch();

export function retryAfterMilliseconds(value: string | null, now: Date): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now.getTime()) : undefined;
}

export function responseHash(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

export function canonicalUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_|fbclid$|gclid$)/i.test(key)) {
      url.searchParams.delete(key);
    }
  }
  return url.toString();
}
