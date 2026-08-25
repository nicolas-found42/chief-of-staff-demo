import { createHash } from "node:crypto";
import { load } from "cheerio";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import type { SourceItem } from "@chief-of-staff-demo/shared";
import type { SourceAdapter, SourceCollectionResult } from "../ports.js";
import { canonicalUrl, publicHttpFetch, responseHash, type PublicHttpFetch } from "./http.js";

export class WebsiteSourceAdapter implements SourceAdapter {
  readonly id = "website";
  readonly state = "available" as const;
  readonly version = "readability@0.6";

  constructor(
    private readonly fetchText: PublicHttpFetch = publicHttpFetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  supports(target: { adapterId: string }): boolean {
    return target.adapterId === this.id;
  }

  async collect(request: Parameters<SourceAdapter["collect"]>[0]): Promise<SourceCollectionResult> {
    const startedAt = this.now().toISOString();
    let response;
    try {
      response = await this.fetchText(request.target.url);
    } catch (error) {
      return this.failure(
        error instanceof Error && error.name === "AbortError" ? "timeout" : "internal_failure",
        request.target.url,
        startedAt,
        null,
        null,
        "fetch",
        "",
        [error instanceof Error ? error.message : String(error)],
      );
    }
    if (
      response.status === 304 ||
      (request.checkpoint && request.checkpoint === responseHash(response.body))
    ) {
      return this.completed("no_new_material", [], request.checkpoint, response, startedAt);
    }
    if (response.status === 401 || response.status === 403) {
      return this.failure(
        "blocked_access",
        response.url,
        startedAt,
        response.status,
        response.contentType,
        "fetch",
        responseHash(response.body),
        [`HTTP ${response.status}`],
      );
    }
    if (response.status === 429) {
      return this.failure(
        "rate_limit",
        response.url,
        startedAt,
        response.status,
        response.contentType,
        "fetch",
        responseHash(response.body),
        ["HTTP 429"],
      );
    }
    if (response.status < 200 || response.status >= 300) {
      return this.failure(
        "internal_failure",
        response.url,
        startedAt,
        response.status,
        response.contentType,
        "fetch",
        responseHash(response.body),
        [`HTTP ${response.status}`],
      );
    }

    const dom = new JSDOM(response.body, { url: response.url });
    const document = dom.window.document;
    const metadata = load(response.body);
    const canonical = new URL(
      metadata('link[rel="canonical"]').attr("href") ?? response.url,
      response.url,
    ).toString();
    const published =
      metadata('meta[property="article:published_time"], meta[name="date"]').attr("content") ??
      metadata("time[datetime]").attr("datetime") ??
      null;
    const article = new Readability(document.cloneNode(true) as Document).parse();
    const text = article?.textContent?.trim() ?? "";
    if (!article || text.length < 40) {
      return this.failure(
        "parser_failure",
        response.url,
        startedAt,
        response.status,
        response.contentType,
        "readability",
        responseHash(response.body),
        ["No meaningful public article body was extracted."],
      );
    }
    const url = canonicalUrl(canonical);
    const externalId = createHash("sha256").update(url).digest("hex").slice(0, 24);
    const item: SourceItem = {
      id: `${request.target.id}:${externalId}`,
      externalId,
      targetId: request.target.id,
      adapterId: this.id,
      canonicalUrl: url,
      author: article.byline ?? null,
      title: article.title || document.title || null,
      body: text,
      description:
        article.excerpt ??
        document.querySelector<HTMLMetaElement>('meta[name="description"]')?.content ??
        null,
      publishedAt:
        published && !Number.isNaN(Date.parse(published))
          ? new Date(published).toISOString()
          : null,
      discoveredAt: this.now().toISOString(),
      media: [],
      transcript: null,
      comments: [],
      evidence: [{ route: response.url, retrievedAt: this.now().toISOString() }],
      completeness: {
        title: article.title || document.title ? "available" : "unavailable",
        body: "available",
        description: article.excerpt ? "available" : "unavailable",
        transcript: "unsupported",
        comments: "unsupported",
      },
    };
    return this.completed("items_found", [item], responseHash(response.body), response, startedAt);
  }

  private completed(
    outcome: "items_found" | "no_new_material",
    items: SourceItem[],
    checkpoint: string | null,
    response: { url: string; status: number; contentType: string | null; body: string },
    startedAt: string,
  ): SourceCollectionResult {
    return {
      kind: "completed",
      outcome,
      items,
      checkpoint,
      diagnostic: {
        classification: outcome,
        route: response.url,
        status: response.status,
        contentType: response.contentType,
        parserStage: "readability",
        responseHash: responseHash(response.body),
        adapterVersion: this.version,
        startedAt,
        finishedAt: this.now().toISOString(),
        retries: 0,
        affectedCapabilities: [],
        causeChain: [],
      },
    };
  }

  private failure(
    outcome: Extract<SourceCollectionResult, { kind: "failed" }>["outcome"],
    route: string,
    startedAt: string,
    status: number | null,
    contentType: string | null,
    parserStage: string,
    hash: string,
    causeChain: string[],
  ): SourceCollectionResult {
    return {
      kind: "failed",
      outcome,
      items: [],
      checkpoint: null,
      diagnostic: {
        classification: outcome,
        route,
        status,
        contentType,
        parserStage,
        responseHash: hash,
        adapterVersion: this.version,
        startedAt,
        finishedAt: this.now().toISOString(),
        retries: 0,
        affectedCapabilities: ["body"],
        causeChain,
      },
    };
  }
}
