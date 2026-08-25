import Parser from "rss-parser";
import type { AdapterDiagnostic, SourceItem } from "@chief-of-staff-demo/shared";
import type { SourceAdapter, SourceCollectionResult } from "../ports.js";
import {
  canonicalUrl,
  publicHttpFetch,
  responseHash,
  retryAfterMilliseconds,
  type PublicHttpFetch,
} from "./http.js";

type FeedItem = {
  guid?: string;
  id?: string;
  link?: string;
  title?: string;
  creator?: string;
  author?: string;
  pubDate?: string;
  isoDate?: string;
  content?: string;
  contentSnippet?: string;
  summary?: string;
};

function failedOutcome(status: number): "blocked_access" | "rate_limit" | "internal_failure" {
  if (status === 401 || status === 403) return "blocked_access";
  if (status === 429) return "rate_limit";
  return "internal_failure";
}

export class RssSourceAdapter implements SourceAdapter {
  readonly id: "rss" | "substack" | "reddit";
  readonly state: "available" | "experimental";
  readonly version = "rss-parser@3";
  private readonly parser = new Parser<Record<string, unknown>, FeedItem>();

  constructor(
    private readonly fetchText: PublicHttpFetch = publicHttpFetch,
    private readonly now: () => Date = () => new Date(),
    declaration: { id: "rss" | "substack" | "reddit"; state: "available" | "experimental" } = {
      id: "rss",
      state: "available",
    },
  ) {
    this.id = declaration.id;
    this.state = declaration.state;
  }

  supports(target: { adapterId: string }): boolean {
    return target.adapterId === this.id;
  }

  async collect(request: Parameters<SourceAdapter["collect"]>[0]): Promise<SourceCollectionResult> {
    const startedAt = this.now().toISOString();
    let response;
    try {
      response = await this.fetchText(this.collectionUrl(request.target.url), {
        etag: request.conditional?.etag ?? null,
        lastModified: request.conditional?.lastModified ?? null,
      });
    } catch (error) {
      const timeout = error instanceof Error && error.name === "AbortError";
      return this.failure(
        timeout ? "timeout" : "internal_failure",
        request.target.url,
        startedAt,
        null,
        null,
        "fetch",
        "",
        [error instanceof Error ? error.message : String(error)],
      );
    }
    if (response.status === 304) {
      return this.completed(
        "no_new_material",
        [],
        request.checkpoint,
        request.conditional ?? null,
        {
          route: response.url,
          status: response.status,
          contentType: response.contentType,
          parserStage: "conditional_request",
          responseHash: responseHash(response.body),
          startedAt,
        },
      );
    }
    if (response.status < 200 || response.status >= 300) {
      return this.failure(
        failedOutcome(response.status),
        response.url,
        startedAt,
        response.status,
        response.contentType,
        "fetch",
        responseHash(response.body),
        [`HTTP ${response.status}`],
        retryAfterMilliseconds(response.retryAfter, this.now()),
        response.body,
      );
    }
    let parsed;
    try {
      parsed = await this.parser.parseString(response.body);
    } catch (error) {
      return this.failure(
        "response_shape_change",
        response.url,
        startedAt,
        response.status,
        response.contentType,
        "rss_parse",
        responseHash(response.body),
        [error instanceof Error ? error.message : String(error)],
        undefined,
        response.body,
      );
    }
    const since = Date.parse(request.since);
    const items: SourceItem[] = [];
    for (const entry of parsed.items) {
      if (!entry.link) continue;
      const publishedAt = entry.isoDate ?? entry.pubDate ?? null;
      if (publishedAt && Date.parse(publishedAt) < since) continue;
      const url = canonicalUrl(new URL(entry.link, response.url).toString());
      const externalId = entry.guid ?? entry.id ?? url;
      const body = entry.content ?? entry.contentSnippet ?? entry.summary ?? null;
      items.push({
        id: `${request.target.id}:${externalId}`,
        externalId,
        targetId: request.target.id,
        adapterId: this.id,
        canonicalUrl: url,
        author: entry.creator ?? entry.author ?? null,
        title: entry.title ?? null,
        body,
        description: entry.contentSnippet ?? entry.summary ?? null,
        publishedAt: publishedAt ? new Date(publishedAt).toISOString() : null,
        discoveredAt: this.now().toISOString(),
        media: [],
        transcript: null,
        comments: [],
        evidence: [{ route: response.url, retrievedAt: this.now().toISOString() }],
        completeness: {
          title: entry.title ? "available" : "unavailable",
          body: body ? "available" : "unavailable",
          description: (entry.contentSnippet ?? entry.summary) ? "available" : "unavailable",
          transcript: "unsupported",
          comments: "unsupported",
        },
      });
    }
    const outcome =
      items.length > 0
        ? "items_found"
        : request.checkpoint
          ? "no_new_material"
          : "legitimate_empty";
    return this.completed(
      outcome,
      items,
      responseHash(response.body),
      { etag: response.etag, lastModified: response.lastModified },
      {
        route: response.url,
        status: response.status,
        contentType: response.contentType,
        parserStage: "rss_parse",
        responseHash: responseHash(response.body),
        startedAt,
      },
    );
  }

  private collectionUrl(value: string): string {
    if (this.id !== "reddit") return value;
    const url = new URL(value);
    if (!url.pathname.endsWith(".rss")) url.pathname = `${url.pathname.replace(/\/$/, "")}.rss`;
    return url.toString();
  }

  private completed(
    outcome: "items_found" | "legitimate_empty" | "no_new_material",
    items: SourceItem[],
    checkpoint: string | null,
    conditional: { etag: string | null; lastModified: string | null } | null,
    receipt: Omit<
      AdapterDiagnostic,
      | "classification"
      | "adapterVersion"
      | "finishedAt"
      | "retries"
      | "affectedCapabilities"
      | "causeChain"
    >,
  ): SourceCollectionResult {
    return {
      kind: "completed",
      outcome,
      items,
      checkpoint,
      conditional,
      diagnostic: {
        classification: outcome,
        adapterVersion: this.version,
        finishedAt: this.now().toISOString(),
        retries: 0,
        affectedCapabilities: [],
        causeChain: [],
        ...receipt,
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
    retryAfterMs?: number,
    body?: string,
  ): SourceCollectionResult {
    return {
      kind: "failed",
      outcome,
      items: [],
      checkpoint: null,
      ...(body
        ? { diagnosticBody: { contentType: contentType ?? "application/octet-stream", body } }
        : {}),
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
        affectedCapabilities: ["items"],
        causeChain,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      },
    };
  }
}
