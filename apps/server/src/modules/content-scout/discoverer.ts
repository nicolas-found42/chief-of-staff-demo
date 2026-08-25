import { JSDOM } from "jsdom";
import type { SourceDiscoverer } from "./ports.js";
import { canonicalUrl, publicHttpFetch, type PublicHttpFetch } from "./adapters/http.js";

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

/** Bounded public-link discovery: it reads only approved target pages and never follows candidates. */
export class PublicLinkSourceDiscoverer implements SourceDiscoverer {
  constructor(private readonly fetchText: PublicHttpFetch = publicHttpFetch) {}

  async discover({ brandProfile, approvedTargets }: Parameters<SourceDiscoverer["discover"]>[0]) {
    const approved = new Set(approvedTargets.map((target) => canonicalUrl(target.url)));
    const candidates = new Map<string, ReturnType<typeof proposal>>();
    const keywords =
      brandProfile.markdown
        .toLowerCase()
        .match(/[a-z][a-z-]{4,}/g)
        ?.filter((word, index, words) => words.indexOf(word) === index)
        .slice(0, 20) ?? [];
    for (const target of approvedTargets
      .filter((candidate) => candidate.state === "active")
      .slice(0, 20)) {
      let response;
      try {
        response = await this.fetchText(target.url);
      } catch {
        continue;
      }
      if (
        response.status < 200 ||
        response.status >= 300 ||
        !/html/i.test(response.contentType ?? "")
      )
        continue;
      const document = new JSDOM(response.body, { url: response.url }).window.document;
      for (const anchor of [...document.querySelectorAll<HTMLAnchorElement>("a[href]")].slice(
        0,
        200,
      )) {
        let url: URL;
        try {
          url = new URL(anchor.href, response.url);
        } catch {
          continue;
        }
        if (!/^https?:$/.test(url.protocol) || url.origin === new URL(response.url).origin)
          continue;
        const canonical = canonicalUrl(url.toString());
        if (approved.has(canonical) || candidates.has(canonical)) continue;
        const context = `${anchor.textContent} ${anchor.getAttribute("aria-label") ?? ""}`.trim();
        const matches = keywords.filter((word) => context.toLowerCase().includes(word)).slice(0, 4);
        candidates.set(
          canonical,
          proposal(canonical, context || url.hostname, target.url, matches),
        );
        if (candidates.size >= 25) break;
      }
      if (candidates.size >= 25) break;
    }
    return [...candidates.values()];
  }
}

function proposal(url: string, label: string, evidenceUrl: string, matches: string[]) {
  const parsed = new URL(url);
  return {
    adapterId: adapterFor(parsed),
    label: label.slice(0, 120),
    url,
    discoveredBecause: "Linked from an approved public Source Target.",
    evidenceUrls: [evidenceUrl],
    similarityFactors:
      matches.length > 0
        ? matches.map((word) => `Brand Profile term: ${word}`)
        : ["Outbound citation from an approved source"],
  };
}
