import { JSDOM } from "jsdom";
import { publicHttpFetch, type PublicHttpFetch } from "./http.js";

export interface PublicSearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** Public search over a bounded anonymous HTML route. */
export type PublicSearch = (query: string) => Promise<PublicSearchResult[]>;

const MAX_RESULTS = 8;

/** A DuckDuckGo HTML result link, unwrapping its `uddg` redirect parameter. */
function resolveHref(href: string, base: string): string | null {
  try {
    const parsed = new URL(href, base);
    const target = parsed.searchParams.get("uddg");
    const resolved = target ? new URL(target) : parsed;
    return resolved.protocol === "http:" || resolved.protocol === "https:"
      ? resolved.toString()
      : null;
  } catch {
    return null;
  }
}

export function createPublicSearch(
  fetchText: PublicHttpFetch = publicHttpFetch,
  endpoint: (query: string) => string = (query) =>
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
): PublicSearch {
  return async (query) => {
    const response = await fetchText(endpoint(query));
    if (response.status < 200 || response.status >= 300) return [];
    if (!/html/i.test(response.contentType ?? "")) return [];
    const document = new JSDOM(response.body, { url: response.url }).window.document;
    const results: PublicSearchResult[] = [];
    for (const anchor of [
      ...document.querySelectorAll<HTMLAnchorElement>("a.result__a[href]"),
    ].slice(0, MAX_RESULTS)) {
      const url = resolveHref(anchor.getAttribute("href") ?? "", response.url);
      if (!url) continue;
      const row = anchor.closest(".result");
      const snippet = row?.querySelector(".result__snippet")?.textContent.trim() ?? "";
      results.push({
        title: anchor.textContent.trim().slice(0, 200),
        url,
        snippet: snippet.slice(0, 400),
      });
    }
    return results;
  };
}
