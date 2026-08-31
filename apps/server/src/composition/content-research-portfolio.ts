import type { SourceAdapter } from "../source-adapters/source-adapter.js";
import { ContentScoutRetention } from "../modules/content-scout/retention.js";
import { ExternalRuntimeInspector } from "../modules/content-scout/runtime.js";
import type { BrowserRenderer } from "../modules/content-scout/adapters/browser.js";
import { RssSourceAdapter } from "../modules/content-scout/adapters/rss.js";
import { WebsiteSourceAdapter } from "../modules/content-scout/adapters/website.js";
import {
  YouTubeSourceAdapter,
  type YouTubeSourceAccess,
} from "../modules/content-scout/adapters/youtube.js";
import { RedditSourceAdapter } from "../modules/content-scout/adapters/reddit.js";
import { HnAlgoliaSourceAdapter } from "../modules/content-research/adapters/hn.js";

/*
 * Why this portfolio lives here and Content Scout's lives with Content Scout.
 *
 * Content Scout owns the adapter implementations, so the factory that arranges
 * them into its own portfolio is its own business and stays in the feature.
 * Content Research borrows six of those implementations. Assembling them inside
 * Content Research would be the reverse feature dependency issue #118 removes;
 * assembling them inside `source-adapters/` would be worse, because nothing in
 * the shared layer may reach into a feature. So the wiring belongs to neither and
 * sits in the composition layer, above both, with the bootstrap that calls it.
 *
 * The asymmetry is the point: it marks which Module owns its collectors and
 * which one borrows them.
 */

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
