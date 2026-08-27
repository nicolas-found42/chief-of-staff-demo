import { JSDOM } from "jsdom";
import type { SourceSuggestion } from "@chief-of-staff-demo/shared";
import type { SourceDiscoverer } from "./ports.js";
import { canonicalUrl, publicHttpFetch, type PublicHttpFetch } from "./adapters/http.js";

const MAX_TARGETS = 20;
const MAX_ANCHORS = 200;
const MAX_ROUTE_CANDIDATES = 25;
const MAX_TOTAL_CANDIDATES = 60;
const MAX_SEARCH_QUERIES = 3;
const MAX_SEARCH_RESULTS = 10;

type DiscoveryProposal = Omit<
  SourceSuggestion,
  "id" | "state" | "discoveredAt" | "decisionReason" | "sourceTargetId"
>;

function adapterFor(url: URL): string {
  const host = url.hostname.replace(/^www\./, "");
  if (host === "youtube.com" || host === "youtu.be") return "youtube";
  if (host === "reddit.com") return "reddit";
  if (host === "instagram.com") return "instagram";
  if (host === "tiktok.com") return "tiktok";
  if (host === "linkedin.com") return "linkedin";
  if (host.endsWith("substack.com")) return "substack";
  return "website";
}

/** Brand terms for similarity and search seeds; Markdown headings are structure, not vocabulary. */
function brandKeywords(markdown: string): string[] {
  const body = markdown.replace(/^#{1,6}\s+.*$/gm, "");
  return (
    body
      .toLowerCase()
      .match(/[a-z][a-z-]{4,}/g)
      ?.filter((word, index, words) => words.indexOf(word) === index) ?? []
  );
}

function resolveUrl(href: string | null, base: string): URL | null {
  if (!href || !href.trim()) return null;
  try {
    return new URL(href, base);
  } catch {
    return null;
  }
}

function httpUrl(url: URL): boolean {
  return /^https?:$/.test(url.protocol);
}

function externalTo(url: URL, base: string): boolean {
  return url.origin !== new URL(base).origin;
}

function anchorLabel(element: Element): string {
  return `${element.textContent} ${element.getAttribute("aria-label") ?? ""}`.trim();
}

/**
 * Bounded public-route discovery. It reads only approved active Source Target
 * pages and one public search endpoint; candidate URLs are recorded as
 * evidence and never fetched again. Each route and each target is isolated, so
 * a malformed page or a failed search query never discards the other routes'
 * findings.
 */
export class PublicRouteSourceDiscoverer implements SourceDiscoverer {
  constructor(
    private readonly fetchText: PublicHttpFetch = publicHttpFetch,
    private readonly searchEndpoint: (query: string) => string = (query) =>
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
  ) {}

  async discover({ brandProfile, approvedTargets }: Parameters<SourceDiscoverer["discover"]>[0]) {
    const approved = new Set(approvedTargets.map((target) => canonicalUrl(target.url)));
    const candidates = new Map<string, DiscoveryProposal>();
    const add = (proposal: DiscoveryProposal): void => {
      if (candidates.size >= MAX_TOTAL_CANDIDATES) return;
      const canonical = canonicalUrl(proposal.url);
      if (approved.has(canonical) || candidates.has(canonical)) return;
      candidates.set(canonical, {
        ...proposal,
        label: proposal.label.slice(0, 120),
        url: canonical,
      });
    };
    const activeTargets = approvedTargets
      .filter((target) => target.state === "active")
      .slice(0, MAX_TARGETS);
    const keywords = brandKeywords(brandProfile.markdown);

    const pages: { document: Document; url: string }[] = [];
    for (const target of activeTargets) {
      try {
        const response = await this.fetchText(target.url);
        if (
          response.status < 200 ||
          response.status >= 300 ||
          !/html/i.test(response.contentType ?? "")
        )
          continue;
        pages.push({
          document: new JSDOM(response.body, { url: response.url }).window.document,
          url: response.url,
        });
      } catch {
        // One unavailable target never stops the others (Source Adapter isolation).
      }
    }

    // Most specific routes run first so a URL's provenance names the route that
    // explains it best; the outbound-link route keeps the general case.
    const pageRoutes: Array<(document: Document, url: string) => void> = [
      (document, url) => this.authorPages(document, url, add),
      (document, url) => this.guests(document, url, add),
      (document, url) => this.citations(document, url, add),
      (document, url) => this.tags(document, url, add),
      (document, url) => this.blogrolls(document, url, add),
      (document, url) => this.relatedResults(document, url, add),
      (document, url) => this.reposts(document, url, add),
      (document, url) => this.outboundLinks(document, url, keywords, add),
    ];
    for (const page of pages) {
      for (const run of pageRoutes) {
        try {
          run(page.document, page.url);
        } catch {
          // One route's failure never discards the others' findings.
        }
      }
      if (candidates.size >= MAX_TOTAL_CANDIDATES) break;
    }

    const searchQueries = [
      ...new Set(
        activeTargets
          .map((target) => {
            try {
              return new URL(target.url).hostname.replace(/^www\./, "");
            } catch {
              return null;
            }
          })
          .filter((hostname): hostname is string => hostname !== null),
      ),
    ].slice(0, MAX_SEARCH_QUERIES);
    await this.searchRoute({
      queries: searchQueries,
      discoveredBecause: (query) => `Public search result related to approved source ${query}.`,
      similarity: (query) => [`Related to approved source: ${query}`],
      add,
    });
    await this.searchRoute({
      queries: keywords.slice(0, MAX_SEARCH_QUERIES),
      discoveredBecause: (query) => `Mentions ${query} in public search results.`,
      similarity: (query) => [`Brand Profile term: ${query}`],
      add,
    });

    return [...candidates.values()];
  }

  private authorPages(
    document: Document,
    pageUrl: string,
    add: (proposal: DiscoveryProposal) => void,
  ): void {
    const links = [
      ...document.querySelectorAll<Element>(
        'a[rel~="author"], a[rel~="me"], link[rel~="author"], link[rel~="me"]',
      ),
    ];
    for (const element of links.slice(0, MAX_ROUTE_CANDIDATES)) {
      const url = resolveUrl(element.getAttribute("href"), pageUrl);
      if (!url || !httpUrl(url)) continue;
      const label = anchorLabel(element);
      add({
        adapterId: adapterFor(url),
        label: label || url.hostname,
        url: url.toString(),
        discoveredBecause: "Author of an approved public Source Target.",
        evidenceUrls: [pageUrl],
        similarityFactors: ["Same author as an approved source"],
      });
    }
    const meta = document.querySelector<HTMLMetaElement>('meta[name="author"][content]');
    if (meta) {
      const url = resolveUrl(meta.content.trim(), pageUrl);
      if (url && httpUrl(url)) {
        add({
          adapterId: adapterFor(url),
          label: url.hostname,
          url: url.toString(),
          discoveredBecause: "Author of an approved public Source Target.",
          evidenceUrls: [pageUrl],
          similarityFactors: ["Same author as an approved source"],
        });
      }
    }
  }

  private guests(
    document: Document,
    pageUrl: string,
    add: (proposal: DiscoveryProposal) => void,
  ): void {
    const anchors = [
      ...document.querySelectorAll<HTMLAnchorElement>(
        '[class*="guest"] a[href], [id*="guest"] a[href], [data-guest] a[href], a[href*="/guest/"]',
      ),
    ];
    for (const anchor of anchors.slice(0, MAX_ROUTE_CANDIDATES)) {
      const url = resolveUrl(anchor.getAttribute("href"), pageUrl);
      if (!url || !httpUrl(url)) continue;
      add({
        adapterId: adapterFor(url),
        label: anchorLabel(anchor) || url.hostname,
        url: url.toString(),
        discoveredBecause: "Guest on an approved public Source Target.",
        evidenceUrls: [pageUrl],
        similarityFactors: ["Guest contributor on an approved source"],
      });
    }
  }

  private citations(
    document: Document,
    pageUrl: string,
    add: (proposal: DiscoveryProposal) => void,
  ): void {
    const anchors = [
      ...document.querySelectorAll<HTMLAnchorElement>(
        'blockquote a[href], cite a[href], sup a[href], a[rel~="nofollow"]',
      ),
    ];
    for (const anchor of anchors.slice(0, MAX_ROUTE_CANDIDATES)) {
      const url = resolveUrl(anchor.getAttribute("href"), pageUrl);
      if (!url || !httpUrl(url) || !externalTo(url, pageUrl)) continue;
      add({
        adapterId: adapterFor(url),
        label: anchorLabel(anchor) || url.hostname,
        url: url.toString(),
        discoveredBecause: "Cited by an approved public Source Target.",
        evidenceUrls: [pageUrl],
        similarityFactors: ["Cited source within approved material"],
      });
    }
  }

  private tags(
    document: Document,
    pageUrl: string,
    add: (proposal: DiscoveryProposal) => void,
  ): void {
    const anchors = [
      ...document.querySelectorAll<HTMLAnchorElement>(
        'a[rel~="tag"], a[href*="/tag/"], a[href*="/tags/"], a[href*="/topic/"], a[href*="/topics/"], a[href*="/category/"], a[href*="/categories/"]',
      ),
    ];
    for (const anchor of anchors.slice(0, MAX_ROUTE_CANDIDATES)) {
      const url = resolveUrl(anchor.getAttribute("href"), pageUrl);
      if (!url || !httpUrl(url)) continue;
      const label = anchorLabel(anchor);
      add({
        adapterId: adapterFor(url),
        label: label || url.hostname,
        url: url.toString(),
        discoveredBecause: "Tagged topic on an approved public Source Target.",
        evidenceUrls: [pageUrl],
        similarityFactors: label ? [`Tag: ${label}`] : ["Tag on an approved source"],
      });
    }
  }

  private blogrolls(
    document: Document,
    pageUrl: string,
    add: (proposal: DiscoveryProposal) => void,
  ): void {
    const anchors = [
      ...document.querySelectorAll<HTMLAnchorElement>(
        'nav a[href], aside a[href], [class*="blogroll"] a[href], [id*="blogroll"] a[href], [class*="blog-roll"] a[href], [class*="links"] a[href], [id*="links"] a[href]',
      ),
    ];
    for (const anchor of anchors.slice(0, MAX_ROUTE_CANDIDATES)) {
      const url = resolveUrl(anchor.getAttribute("href"), pageUrl);
      if (!url || !httpUrl(url) || !externalTo(url, pageUrl)) continue;
      add({
        adapterId: adapterFor(url),
        label: anchorLabel(anchor) || url.hostname,
        url: url.toString(),
        discoveredBecause: "Listed in an approved public Source Target's blogroll.",
        evidenceUrls: [pageUrl],
        similarityFactors: ["Curated link from an approved source"],
      });
    }
  }

  private relatedResults(
    document: Document,
    pageUrl: string,
    add: (proposal: DiscoveryProposal) => void,
  ): void {
    const anchors = [
      ...document.querySelectorAll<HTMLAnchorElement>(
        'a[rel~="related"], a[class*="related"], a[id*="related"], a[class*="recommended"], [class*="related"] a[href], [id*="related"] a[href], [class*="recommended"] a[href], [class*="see-also"] a[href], [class*="see_also"] a[href]',
      ),
    ];
    for (const anchor of anchors.slice(0, MAX_ROUTE_CANDIDATES)) {
      const url = resolveUrl(anchor.getAttribute("href"), pageUrl);
      if (!url || !httpUrl(url) || !externalTo(url, pageUrl)) continue;
      add({
        adapterId: adapterFor(url),
        label: anchorLabel(anchor) || url.hostname,
        url: url.toString(),
        discoveredBecause: "Recommended or related on an approved public Source Target.",
        evidenceUrls: [pageUrl],
        similarityFactors: ["Related recommendation from an approved source"],
      });
    }
    for (const meta of document.querySelectorAll<HTMLMetaElement>(
      'meta[property="og:see_also"][content]',
    )) {
      const url = resolveUrl(meta.content.trim(), pageUrl);
      if (!url || !httpUrl(url) || !externalTo(url, pageUrl)) continue;
      add({
        adapterId: adapterFor(url),
        label: url.hostname,
        url: url.toString(),
        discoveredBecause: "Recommended or related on an approved public Source Target.",
        evidenceUrls: [pageUrl],
        similarityFactors: ["Related recommendation from an approved source"],
      });
    }
  }

  private reposts(
    document: Document,
    pageUrl: string,
    add: (proposal: DiscoveryProposal) => void,
  ): void {
    const anchors = [
      ...document.querySelectorAll<HTMLAnchorElement>(
        'a[rel~="repost"], a[rel~="boost"], a[class*="repost"], a[class*="boost"], a[href*="/repost"], a[href*="/boost"]',
      ),
    ];
    for (const anchor of anchors.slice(0, MAX_ROUTE_CANDIDATES)) {
      const url = resolveUrl(anchor.getAttribute("href"), pageUrl);
      if (!url || !httpUrl(url) || !externalTo(url, pageUrl)) continue;
      add({
        adapterId: adapterFor(url),
        label: anchorLabel(anchor) || url.hostname,
        url: url.toString(),
        discoveredBecause: "Reposted or boosted from an approved public Source Target.",
        evidenceUrls: [pageUrl],
        similarityFactors: ["Reposted or boosted by an approved source"],
      });
    }
  }

  private outboundLinks(
    document: Document,
    pageUrl: string,
    keywords: string[],
    add: (proposal: DiscoveryProposal) => void,
  ): void {
    for (const anchor of [...document.querySelectorAll<HTMLAnchorElement>("a[href]")].slice(
      0,
      MAX_ANCHORS,
    )) {
      const url = resolveUrl(anchor.getAttribute("href"), pageUrl);
      if (!url || !httpUrl(url) || !externalTo(url, pageUrl)) continue;
      const context = anchorLabel(anchor);
      const matches = keywords.filter((word) => context.toLowerCase().includes(word)).slice(0, 4);
      add({
        adapterId: adapterFor(url),
        label: context || url.hostname,
        url: url.toString(),
        discoveredBecause: "Linked from an approved public Source Target.",
        evidenceUrls: [pageUrl],
        similarityFactors:
          matches.length > 0
            ? matches.map((word) => `Brand Profile term: ${word}`)
            : ["Outbound citation from an approved source"],
      });
    }
  }

  private async searchRoute(input: {
    queries: string[];
    discoveredBecause: (query: string) => string;
    similarity: (query: string) => string[];
    add: (proposal: DiscoveryProposal) => void;
  }): Promise<void> {
    for (const query of input.queries) {
      let results: { url: URL; label: string }[];
      try {
        results = await this.search(query);
      } catch {
        // One failed query never stops the others.
        continue;
      }
      for (const result of results.slice(0, MAX_SEARCH_RESULTS)) {
        input.add({
          adapterId: adapterFor(result.url),
          label: result.label || result.url.hostname,
          url: result.url.toString(),
          discoveredBecause: input.discoveredBecause(query),
          evidenceUrls: [this.searchEndpoint(query)],
          similarityFactors: input.similarity(query),
        });
      }
    }
  }

  private async search(query: string): Promise<{ url: URL; label: string }[]> {
    const endpoint = this.searchEndpoint(query);
    const response = await this.fetchText(endpoint);
    if (
      response.status < 200 ||
      response.status >= 300 ||
      !/html/i.test(response.contentType ?? "")
    )
      return [];
    const document = new JSDOM(response.body, { url: response.url }).window.document;
    const results: { url: URL; label: string }[] = [];
    for (const anchor of [
      ...document.querySelectorAll<HTMLAnchorElement>("a.result__a[href]"),
    ].slice(0, MAX_SEARCH_RESULTS)) {
      let url: URL;
      try {
        const parsed = new URL(anchor.getAttribute("href") ?? "", response.url);
        const target = parsed.searchParams.get("uddg");
        url = target ? new URL(target) : parsed;
      } catch {
        continue;
      }
      if (!httpUrl(url)) continue;
      results.push({ url, label: anchorLabel(anchor) });
    }
    return results;
  }
}
