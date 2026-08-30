import type { SourceAdapter } from "../../content-scout/ports.js";
import { ContentScoutRetention } from "../../content-scout/retention.js";
import { ExternalRuntimeInspector } from "../../content-scout/runtime.js";
import type { BrowserRenderer } from "../../content-scout/adapters/browser.js";
import { RssSourceAdapter } from "../../content-scout/adapters/rss.js";
import { WebsiteSourceAdapter } from "../../content-scout/adapters/website.js";
import {
  YouTubeSourceAdapter,
  type YouTubeSourceAccess,
} from "../../content-scout/adapters/youtube.js";
import { RedditSourceAdapter } from "../../content-scout/adapters/reddit.js";
import { HnAlgoliaSourceAdapter } from "./hn.js";

/**
 * Content Research's V1 portfolio (spec #116): RSS (Substack native feeds on
 * the shared RSS route), website enrichment, YouTube on the Shell Google
 * connection, polite anonymous Reddit, keyless HN Algolia, and Google News —
 * which publishes search results as an ordinary RSS feed, so the shared RSS
 * route collects it under its own platform id. No LinkedIn, no login, no
 * imported cookies, no new secret.
 */
export function contentResearchProductionAdapters(input: {
  workspaceDir: string;
  renderBrowser: BrowserRenderer;
  getYouTubeAccess: () => YouTubeSourceAccess;
  now?: () => Date;
}): SourceAdapter[] {
  const now = input.now ?? (() => new Date());
  return [
    new RssSourceAdapter(undefined, now),
    new RssSourceAdapter(undefined, now, { id: "news" }),
    new WebsiteSourceAdapter(undefined, now, input.renderBrowser),
    new YouTubeSourceAdapter(input.getYouTubeAccess, now, {
      runtimeInspector: new ExternalRuntimeInspector(now),
      retention: new ContentScoutRetention(input.workspaceDir, now),
    }),
    new RedditSourceAdapter(undefined, now),
    new HnAlgoliaSourceAdapter(undefined, now),
  ];
}
