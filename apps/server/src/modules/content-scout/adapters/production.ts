import type { SourceAdapter } from "../../../workspace/public-research/source-adapter.js";
import { ContentScoutRetention } from "../retention.js";
import { ExternalRuntimeInspector } from "../runtime.js";
import type { BrowserRenderer } from "./browser.js";
import { InstagramInstaloaderAdapter } from "./instagram.js";
import { LinkedInComingLaterAdapter } from "./linkedin.js";
import { RedditSourceAdapter } from "./reddit.js";
import { RssSourceAdapter } from "./rss.js";
import { SubstackEnrichmentAdapter } from "./substack.js";
import { TikTokYtDlpAdapter } from "./tiktok.js";
import { WebsiteSourceAdapter } from "./website.js";
import { YouTubeSourceAdapter, type YouTubeSourceAccess } from "./youtube.js";

export function contentScoutProductionAdapters(input: {
  workspaceDir: string;
  renderBrowser: BrowserRenderer;
  getYouTubeAccess: () => YouTubeSourceAccess;
  now?: () => Date;
}): SourceAdapter[] {
  const now = input.now ?? (() => new Date());
  return [
    new RssSourceAdapter(undefined, now),
    new RssSourceAdapter(undefined, now, { id: "substack" }),
    new WebsiteSourceAdapter(undefined, now, input.renderBrowser),
    new SubstackEnrichmentAdapter(undefined, now),
    new YouTubeSourceAdapter(input.getYouTubeAccess, now, {
      runtimeInspector: new ExternalRuntimeInspector(now),
      retention: new ContentScoutRetention(input.workspaceDir, now),
    }),
    new RedditSourceAdapter(undefined, now),
    new InstagramInstaloaderAdapter(undefined, undefined, now),
    new TikTokYtDlpAdapter(undefined, undefined, now),
    new LinkedInComingLaterAdapter(input.renderBrowser, now),
  ];
}
