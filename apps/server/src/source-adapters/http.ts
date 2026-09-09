import { createHash } from "node:crypto";
import { isIP, type LookupFunction } from "node:net";
import CacheableLookup from "cacheable-lookup";
import { Agent, fetch as undiciFetch, type Dispatcher } from "undici";

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

function privateIpv4(hostname: string): boolean {
  const octets = hostname.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part))) {
    return false;
  }
  const [a, b] = octets as [number, number, number, number];
  return (
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a === 0
  );
}

export function assertPublicHttpUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Source Targets must use public HTTP or HTTPS URLs.");
  }
  const hostname = url.hostname.toLowerCase();
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    privateIpv4(hostname) ||
    (isIP(hostname) === 6 &&
      (hostname === "::1" ||
        hostname.startsWith("fc") ||
        hostname.startsWith("fd") ||
        hostname.startsWith("fe80")))
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
function pooledLookup(lookup: CacheableLookup): LookupFunction {
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
        let family: number | undefined;
        for (const address of result) {
          family = address.family;
          break;
        }
        callback(error, [...result], family);
      });
    } else {
      lookup.lookup(hostname, base, (error, address, family) => {
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
export function createSourceHttpDispatcher(): SourceHttpDispatcher {
  const lookup = new CacheableLookup();
  return new Agent({
    keepAliveTimeout: SOURCE_HTTP_KEEP_ALIVE_TIMEOUT_MS,
    keepAliveMaxTimeout: SOURCE_HTTP_KEEP_ALIVE_MAX_TIMEOUT_MS,
    // Undici's default; stated so the no-pipelining choice reads as deliberate.
    pipelining: 1,
    connect: {
      timeout: SOURCE_HTTP_CONNECT_TIMEOUT_MS,
      autoSelectFamily: true,
      lookup: pooledLookup(lookup),
    },
  });
}

let sharedDispatcher: SourceHttpDispatcher | undefined;

/** The process-wide pooling dispatcher behind the default transports. */
function sharedSourceHttpDispatcher(): SourceHttpDispatcher {
  sharedDispatcher ??= createSourceHttpDispatcher();
  return sharedDispatcher;
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
  const dispatcher = options.dispatcher ?? sharedSourceHttpDispatcher();
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
      const response = await undiciFetch(url, {
        ...(perCall.method !== undefined ? { method: perCall.method } : {}),
        ...(perCall.body !== undefined ? { body: perCall.body } : {}),
        headers: perCall.body
          ? { ...headers, "content-type": "application/x-www-form-urlencoded" }
          : headers,
        redirect: "follow",
        signal: controller.signal,
        credentials: "omit",
        dispatcher,
      });
      const body = await response.text();
      if (body.length > 5_000_000) {
        throw new Error("Source response exceeded the 5 MB collection limit.");
      }
      return {
        url: response.url || url.toString(),
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
      const response = await undiciFetch(url, {
        headers: {
          accept: perCall.accept ?? "application/pdf, application/octet-stream, */*;q=0.8",
          "user-agent": "Found42-Content-Scout/1.0 (+public-source-monitor)",
          ...options.headers,
        },
        redirect: "follow",
        signal: controller.signal,
        credentials: "omit",
        // Same pooled dispatcher as the text transport; see the note there.
        dispatcher,
      });
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.byteLength > 5_000_000)
        throw new Error("Source response exceeded the 5 MB collection limit.");
      return {
        url: response.url || url.toString(),
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
