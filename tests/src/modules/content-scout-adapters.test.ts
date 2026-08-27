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
  conditional: null,
});

const response = (overrides: Partial<PublicHttpResponse> = {}): PublicHttpResponse => ({
  url: "https://example.com/feed.xml",
  status: 200,
  contentType: "application/rss+xml",
  etag: null,
  lastModified: null,
  retryAfter: null,
  body: fixture("rss-success.xml"),
  ...overrides,
});

describe("RSS Source Adapter fixture contract", () => {
  it("forwards persisted validators and returns refreshed conditional-request state", async () => {
    let options: unknown;
    const result = await new RssSourceAdapter(
      async (_url, received) => {
        options = received;
        return response({
          etag: '"feed-v2"',
          lastModified: "Tue, 25 Aug 2026 12:00:00 GMT",
        });
      },
      () => NOW,
    ).collect({
      target: target("rss", "https://example.com/feed.xml"),
      since: "2026-08-18T12:00:00.000Z",
      until: NOW.toISOString(),
      checkpoint: "feed-v1",
      conditional: {
        etag: '"feed-v1"',
        lastModified: "Mon, 24 Aug 2026 12:00:00 GMT",
      },
    });

    expect(options).toEqual({
      etag: '"feed-v1"',
      lastModified: "Mon, 24 Aug 2026 12:00:00 GMT",
    });
    expect(result).toMatchObject({
      kind: "completed",
      conditional: {
        etag: '"feed-v2"',
        lastModified: "Tue, 25 Aug 2026 12:00:00 GMT",
      },
    });
  });

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
  it("extracts a public article through plain HTTP and Readability without a browser", async () => {
    let rendered = 0;
    const adapter = new WebsiteSourceAdapter(
      async () =>
        response({
          url: "https://news.example/updates",
          contentType: "text/html",
          body: fixture("website-article.html"),
        }),
      () => NOW,
      async () => {
        rendered += 1;
        return {
          url: "https://news.example/updates",
          contentType: "text/html",
          status: 200,
          body: "",
        };
      },
    );
    const result = await adapter.collect({
      target: target("website", "https://news.example/updates"),
      since: "2026-08-18T12:00:00.000Z",
      until: NOW.toISOString(),
      checkpoint: null,
    });
    expect(rendered).toBe(0);
    expect(result).toMatchObject({
      kind: "completed",
      outcome: "items_found",
      diagnostic: { parserStage: "readability" },
      items: [
        {
          canonicalUrl: "https://news.example/product-update",
          title: "Public product update",
          completeness: { body: "available", comments: "unsupported" },
        },
      ],
    });
  });

  it("keeps a static parser break classified without invoking the browser", async () => {
    let rendered = 0;
    const result = await new WebsiteSourceAdapter(
      async () =>
        response({
          url: "https://news.example/updates",
          contentType: "text/html",
          body: fixture("website-parse-failure.html"),
        }),
      () => NOW,
      async () => {
        rendered += 1;
        return {
          url: "https://news.example/updates",
          contentType: "text/html",
          status: 200,
          body: "",
        };
      },
    ).collect({
      target: target("website", "https://news.example/updates"),
      since: "2026-08-18T12:00:00.000Z",
      until: NOW.toISOString(),
      checkpoint: null,
    });
    expect(rendered).toBe(0);
    expect(result).toMatchObject({
      kind: "failed",
      outcome: "parser_failure",
      diagnostic: { parserStage: "readability" },
    });
  });

  it("renders a JavaScript-only shell through the bounded public browser fallback", async () => {
    const renderedBody = fixture("website-rendered-article.html");
    let renderedUrl = "";
    const adapter = new WebsiteSourceAdapter(
      async () =>
        response({
          url: "https://news.example/updates",
          contentType: "text/html",
          body: fixture("website-shell.html"),
        }),
      () => NOW,
      async (url) => {
        renderedUrl = url;
        return {
          url: "https://news.example/product-update",
          contentType: "text/html",
          status: 200,
          body: renderedBody,
        };
      },
    );
    const request = {
      target: target("website", "https://news.example/updates"),
      since: "2026-08-18T12:00:00.000Z",
      until: NOW.toISOString(),
      checkpoint: null,
    };
    const result = await adapter.collect(request);
    expect(renderedUrl).toBe("https://news.example/updates");
    expect(result).toMatchObject({
      kind: "completed",
      outcome: "items_found",
      conditional: { etag: null, lastModified: null },
      diagnostic: { parserStage: "browser_render" },
      items: [
        {
          canonicalUrl: "https://news.example/product-update",
          title: "Public product update",
          evidence: [{ route: "https://news.example/product-update" }],
          completeness: { body: "available", comments: "unsupported" },
        },
      ],
    });
    expect(result.items[0]?.body).toContain("Example Research released");

    const unchanged = await adapter.collect({ ...request, checkpoint: result.checkpoint });
    expect(unchanged).toMatchObject({
      kind: "completed",
      outcome: "no_new_material",
      items: [],
      diagnostic: { parserStage: "browser_render" },
    });
  });

  it("reports a rendered but genuinely empty section as a legitimate empty", async () => {
    let rendered = 0;
    const result = await new WebsiteSourceAdapter(
      async () =>
        response({
          url: "https://news.example/section",
          contentType: "text/html",
          body: fixture("website-shell.html"),
        }),
      () => NOW,
      async (url) => {
        rendered += 1;
        return {
          url,
          contentType: "text/html",
          status: 200,
          body: fixture("website-rendered-empty.html"),
        };
      },
    ).collect({
      target: target("website", "https://news.example/section"),
      since: "2026-08-18T12:00:00.000Z",
      until: NOW.toISOString(),
      checkpoint: null,
    });
    expect(rendered).toBe(1);
    expect(result).toMatchObject({
      kind: "completed",
      outcome: "legitimate_empty",
      items: [],
      diagnostic: { parserStage: "browser_render" },
    });
  });

  it("keeps plain-HTTP failures in front of the browser route", async () => {
    let rendered = 0;
    const render = async (url: string) => {
      rendered += 1;
      return {
        url,
        contentType: "text/html",
        status: 200,
        body: fixture("website-rendered-article.html"),
      };
    };
    const request = {
      target: target("website", "https://news.example/updates"),
      since: "2026-08-18T12:00:00.000Z",
      until: NOW.toISOString(),
      checkpoint: null,
    };
    const blocked = await new WebsiteSourceAdapter(
      async () =>
        response({
          url: "https://news.example/updates",
          status: 403,
          body: fixture("website-blocked.html"),
        }),
      () => NOW,
      render,
    ).collect(request);
    expect(blocked).toMatchObject({
      kind: "failed",
      outcome: "blocked_access",
      diagnostic: { parserStage: "fetch", status: 403 },
    });

    const limited = await new WebsiteSourceAdapter(
      async () =>
        response({
          url: "https://news.example/updates",
          status: 429,
          retryAfter: "30",
          body: fixture("website-rate-limited.html"),
        }),
      () => NOW,
      render,
    ).collect(request);
    expect(limited).toMatchObject({
      kind: "failed",
      outcome: "rate_limit",
      diagnostic: { parserStage: "fetch", retryAfterMs: 30_000 },
    });
    expect(rendered).toBe(0);
  });

  it("classifies a browser render timeout separately from the fetch route", async () => {
    const timeout = new Error("Navigation timed out.");
    timeout.name = "AbortError";
    const result = await new WebsiteSourceAdapter(
      async () =>
        response({
          url: "https://news.example/updates",
          contentType: "text/html",
          body: fixture("website-shell.html"),
        }),
      () => NOW,
      async () => {
        throw timeout;
      },
    ).collect({
      target: target("website", "https://news.example/updates"),
      since: "2026-08-18T12:00:00.000Z",
      until: NOW.toISOString(),
      checkpoint: null,
    });
    expect(result).toMatchObject({
      kind: "failed",
      outcome: "timeout",
      diagnostic: { parserStage: "browser_render" },
    });
  });

  it("keeps a rendered access or rate-limit response classified at the browser stage", async () => {
    const request = {
      target: target("website", "https://news.example/updates"),
      since: "2026-08-18T12:00:00.000Z",
      until: NOW.toISOString(),
      checkpoint: null,
    };
    const blocked = await new WebsiteSourceAdapter(
      async () =>
        response({
          url: "https://news.example/updates",
          contentType: "text/html",
          body: fixture("website-shell.html"),
        }),
      () => NOW,
      async (url) => ({
        url,
        contentType: "text/html",
        status: 403,
        body: fixture("website-blocked.html"),
      }),
    ).collect(request);
    expect(blocked).toMatchObject({
      kind: "failed",
      outcome: "blocked_access",
      diagnostic: { parserStage: "browser_render", status: 403 },
    });

    const limited = await new WebsiteSourceAdapter(
      async () =>
        response({
          url: "https://news.example/updates",
          contentType: "text/html",
          body: fixture("website-shell.html"),
        }),
      () => NOW,
      async (url) => ({
        url,
        contentType: "text/html",
        status: 429,
        body: fixture("website-rate-limited.html"),
      }),
    ).collect(request);
    expect(limited).toMatchObject({
      kind: "failed",
      outcome: "rate_limit",
      diagnostic: { parserStage: "browser_render", status: 429 },
    });
  });

  it("classifies a browser launch failure without hiding it behind a parser break", async () => {
    const result = await new WebsiteSourceAdapter(
      async () =>
        response({
          url: "https://news.example/updates",
          contentType: "text/html",
          body: fixture("website-shell.html"),
        }),
      () => NOW,
      async () => {
        throw new Error("Chromium executable or library is missing from this runtime.");
      },
    ).collect({
      target: target("website", "https://news.example/updates"),
      since: "2026-08-18T12:00:00.000Z",
      until: NOW.toISOString(),
      checkpoint: null,
    });
    expect(result).toMatchObject({
      kind: "failed",
      outcome: "internal_failure",
      diagnostic: {
        parserStage: "browser_render",
        causeChain: ["Chromium executable or library is missing from this runtime."],
      },
    });
  });

  it("reports a rendered page that no longer parses as a browser-stage parser failure", async () => {
    const result = await new WebsiteSourceAdapter(
      async () =>
        response({
          url: "https://news.example/updates",
          contentType: "text/html",
          body: fixture("website-shell.html"),
        }),
      () => NOW,
      async (url) => ({
        url,
        contentType: "text/html",
        status: 200,
        body: fixture("website-parse-failure.html"),
      }),
    ).collect({
      target: target("website", "https://news.example/updates"),
      since: "2026-08-18T12:00:00.000Z",
      until: NOW.toISOString(),
      checkpoint: null,
    });
    expect(result).toMatchObject({
      kind: "failed",
      outcome: "parser_failure",
      diagnostic: { parserStage: "browser_render", affectedCapabilities: ["body"] },
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
