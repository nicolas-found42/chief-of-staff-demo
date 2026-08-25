import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RssSourceAdapter } from "../../../apps/server/src/modules/content-scout/adapters/rss";
import type { PublicHttpResponse } from "../../../apps/server/src/modules/content-scout/adapters/http";
import { WebsiteSourceAdapter } from "../../../apps/server/src/modules/content-scout/adapters/website";
import { ExperimentalPublicPageAdapter } from "../../../apps/server/src/modules/content-scout/adapters/experimental";
import {
  YouTubeSourceAdapter,
  type YouTubeSourceClient,
} from "../../../apps/server/src/modules/content-scout/adapters/youtube";
import type { SourceTarget } from "@chief-of-staff-demo/shared";

const NOW = new Date("2026-08-25T12:00:00.000Z");
const fixture = (name: string) =>
  readFileSync(join(process.cwd(), "fixtures", "content-scout", name), "utf8");

const target = (adapterId: string, url: string): SourceTarget => ({
  id: `target-${adapterId}`,
  adapterId,
  label: adapterId,
  url,
  state: "active",
  createdAt: "2026-08-20T12:00:00.000Z",
  archivedAt: null,
  checkpoint: null,
  lastSuccessfulAt: null,
});

const response = (overrides: Partial<PublicHttpResponse> = {}): PublicHttpResponse => ({
  url: "https://example.com/feed.xml",
  status: 200,
  contentType: "application/rss+xml",
  etag: null,
  lastModified: null,
  body: fixture("rss-success.xml"),
  ...overrides,
});

describe("RSS Source Adapter fixture contract", () => {
  it("normalizes successful and partial items with field-level completeness", async () => {
    const adapter = new RssSourceAdapter(
      async () => response(),
      () => NOW,
    );
    const result = await adapter.collect({
      target: target("rss", "https://example.com/feed.xml"),
      since: "2026-08-18T12:00:00.000Z",
      until: NOW.toISOString(),
      checkpoint: null,
    });

    expect(result.kind).toBe("completed");
    expect(result.outcome).toBe("items_found");
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({
      externalId: "story-1",
      canonicalUrl: "https://example.com/story-1",
      completeness: { title: "available", body: "available" },
    });
    expect(result.items[1]?.completeness).toMatchObject({
      title: "unavailable",
      body: "unavailable",
    });
  });

  it.each([
    ["empty", response({ body: fixture("rss-empty.xml") }), "legitimate_empty"],
    ["blocked", response({ status: 403, body: "Forbidden" }), "blocked_access"],
    ["rate limited", response({ status: 429, body: "Slow down" }), "rate_limit"],
    [
      "response shape changed",
      response({ contentType: "text/html", body: fixture("rss-malformed.xml") }),
      "response_shape_change",
    ],
  ])("classifies %s without sharing a success shape", async (_name, raw, classification) => {
    const result = await new RssSourceAdapter(
      async () => raw,
      () => NOW,
    ).collect({
      target: target("rss", "https://example.com/feed.xml"),
      since: "2026-08-18T12:00:00.000Z",
      until: NOW.toISOString(),
      checkpoint: null,
    });
    expect(result.outcome).toBe(classification);
    expect(result.diagnostic.classification).toBe(classification);
    expect(result.kind).toBe(classification === "legitimate_empty" ? "completed" : "failed");
  });
});

describe("Website Source Adapter fixture contract", () => {
  it("extracts a public article and reports a parser break loudly", async () => {
    const adapter = new WebsiteSourceAdapter(
      async () =>
        response({
          url: "https://news.example/updates",
          contentType: "text/html",
          body: fixture("website-article.html"),
        }),
      () => NOW,
    );
    const request = {
      target: target("website", "https://news.example/updates"),
      since: "2026-08-18T12:00:00.000Z",
      until: NOW.toISOString(),
      checkpoint: null,
    };
    const success = await adapter.collect(request);
    expect(success).toMatchObject({
      kind: "completed",
      outcome: "items_found",
      items: [
        {
          canonicalUrl: "https://news.example/product-update",
          title: "Public product update",
          completeness: { body: "available", comments: "unsupported" },
        },
      ],
    });

    const broken = await new WebsiteSourceAdapter(
      async () =>
        response({
          url: "https://news.example/updates",
          contentType: "text/html",
          body: fixture("website-shape-change.html"),
        }),
      () => NOW,
    ).collect(request);
    expect(broken).toMatchObject({
      kind: "failed",
      outcome: "parser_failure",
      diagnostic: { affectedCapabilities: ["body"] },
    });
  });
});

describe("YouTube Source Adapter fixture contract", () => {
  it("uses the existing official connection seam and enriches at most 50 comments", async () => {
    const data = JSON.parse(fixture("youtube-channel.json")) as {
      channel: { id: string; uploadsPlaylistId: string };
      videos: Awaited<ReturnType<YouTubeSourceClient["listUploads"]>>;
      comments: Awaited<ReturnType<YouTubeSourceClient["listComments"]>>;
    };
    let commentLimit = 0;
    const client: YouTubeSourceClient = {
      async resolveChannel() {
        return data.channel;
      },
      async listUploads() {
        return data.videos;
      },
      async listComments(_videoId, limit) {
        commentLimit = limit;
        return data.comments;
      },
    };
    const adapter = new YouTubeSourceAdapter(
      () => ({ ok: true, client }),
      () => NOW,
    );
    const result = await adapter.collect({
      target: target("youtube", "https://www.youtube.com/@found42"),
      since: "2026-08-18T12:00:00.000Z",
      until: NOW.toISOString(),
      checkpoint: null,
    });
    expect(result).toMatchObject({
      kind: "completed",
      outcome: "items_found",
      items: [
        {
          externalId: "video-1",
          completeness: { transcript: "unavailable", comments: "unavailable" },
        },
      ],
    });
    const enriched = await adapter.enrich(result.items);
    expect(commentLimit).toBe(50);
    expect(enriched[0]).toMatchObject({
      comments: [{ text: "How would a small team apply this?" }],
      completeness: { comments: "available" },
    });
  });

  it("keeps a disconnected official connection distinct from an empty channel", async () => {
    const result = await new YouTubeSourceAdapter(
      () => ({ ok: false, state: "disconnected" }),
      () => NOW,
    ).collect({
      target: target("youtube", "https://www.youtube.com/@found42"),
      since: "2026-08-18T12:00:00.000Z",
      until: NOW.toISOString(),
      checkpoint: null,
    });
    expect(result).toMatchObject({ kind: "failed", outcome: "blocked_access", items: [] });
  });
});

describe("Experimental anonymous social adapters", () => {
  it.each(["instagram", "tiktok"] as const)(
    "keeps %s Experimental while normalizing explicit public embedded evidence",
    async (platform) => {
      const adapter = new ExperimentalPublicPageAdapter(
        platform,
        async () =>
          response({
            url: `https://www.${platform}.com/public-creator`,
            contentType: "text/html",
            body: fixture("social-public-page.html").replaceAll("instagram", platform),
          }),
        () => NOW,
      );
      const request = {
        target: target(platform, `https://www.${platform}.com/public-creator`),
        since: "2026-08-18T12:00:00.000Z",
        until: NOW.toISOString(),
        checkpoint: null,
      };
      const result = await adapter.collect(request);
      expect(adapter.state).toBe("experimental");
      expect(result).toMatchObject({
        kind: "completed",
        outcome: "items_found",
        items: [
          {
            externalId: "public-post-42",
            adapterId: platform,
            completeness: { transcript: "unavailable", comments: "unavailable" },
          },
        ],
      });

      const changed = await new ExperimentalPublicPageAdapter(
        platform,
        async () =>
          response({
            url: `https://www.${platform}.com/public-creator`,
            contentType: "text/html",
            body: fixture("social-shape-change.html"),
          }),
        () => NOW,
      ).collect(request);
      expect(changed).toMatchObject({
        kind: "failed",
        outcome: "response_shape_change",
        diagnostic: { affectedCapabilities: ["items", "transcript", "comments"] },
      });
    },
  );

  it("uses Reddit's public RSS route without presenting it as Available", async () => {
    let fetched = "";
    const adapter = new RssSourceAdapter(
      async (url) => {
        fetched = url;
        return response({ url, body: fixture("rss-success.xml") });
      },
      () => NOW,
      { id: "reddit", state: "experimental" },
    );
    const result = await adapter.collect({
      target: target("reddit", "https://www.reddit.com/r/publiccommunity/"),
      since: "2026-08-18T12:00:00.000Z",
      until: NOW.toISOString(),
      checkpoint: null,
    });
    expect(fetched).toBe("https://www.reddit.com/r/publiccommunity.rss");
    expect(adapter.state).toBe("experimental");
    expect(result.items[0]?.adapterId).toBe("reddit");
  });
});
