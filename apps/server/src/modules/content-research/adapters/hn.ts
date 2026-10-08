import { z } from "zod/v3";
import type {
  AdapterDiagnostic,
  SourceAdapterCanaryTarget,
  SourceDiagnosticClassification,
  SourceFieldState,
  SourceItem,
} from "@chief-of-staff-demo/shared";
import { SOURCE_BACKFILL_WINDOWS_DAYS } from "@chief-of-staff-demo/shared";
import type {
  SourceAdapter,
  SourceCollectionResult,
} from "../../../source-adapters/source-adapter.js";
import {
  publicHttpFetch,
  responseHash,
  retryAfterMilliseconds,
  type PublicHttpFetch,
} from "../../../source-adapters/http.js";

const AlgoliaPageSchema = z.object({
  hits: z.array(
    z.object({
      objectID: z.string().min(1),
      title: z.string().nullable().optional(),
      story_title: z.string().nullable().optional(),
      comment_text: z.string().nullable().optional(),
      story_text: z.string().nullable().optional(),
      author: z.string().nullable().optional(),
      points: z.number().finite().nullable().optional(),
      created_at: z.string().nullable().optional(),
    }),
  ),
  nbPages: z.number().int().nonnegative().optional(),
  nbHits: z.number().int().nonnegative().optional(),
  page: z.number().int().nonnegative().optional(),
});
type AlgoliaHit = z.infer<typeof AlgoliaPageSchema>["hits"][number];

type FailedOutcome = Exclude<
  SourceDiagnosticClassification,
  "items_found" | "legitimate_empty" | "no_new_material"
>;

function fieldState(present: boolean): SourceFieldState {
  return present ? "available" : "unavailable";
}

function failed(
  version: string,
  route: string,
  classification: FailedOutcome,
  status: number | null,
  cause: string,
  startedAt: string,
  finishedAt: string,
  retryAfterMs?: number,
): SourceCollectionResult {
  const diagnostic: AdapterDiagnostic = {
    classification,
    route,
    status,
    contentType: null,
    parserStage: "fetch",
    responseHash: "",
    adapterVersion: version,
    startedAt,
    finishedAt,
    retries: 0,
    affectedCapabilities: [],
    causeChain: [cause],
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  };
  return { kind: "failed", outcome: classification, items: [], checkpoint: null, diagnostic };
}

/**
 * Hacker News via the keyless Algolia search API (https://hn.algolia.com/api).
 * `search_by_date` honors a genuine historical `since` (`numericFilters` on
 * `created_at`), so every backfill window is declared and honored honestly.
 */
export class HnAlgoliaSourceAdapter implements SourceAdapter {
  readonly id = "hn" as const;
  readonly state = "available" as const;
  readonly version = "hn-algolia-v2";
  readonly backfillWindowsDays = SOURCE_BACKFILL_WINDOWS_DAYS;
  readonly canaryTargets: readonly SourceAdapterCanaryTarget[] = [
    {
      adapterId: "hn",
      label: "Hacker News search_by_date",
      url: "https://hn.algolia.com/api/v1/search_by_date?tags=story&hitsPerPage=5",
    },
  ];

  constructor(
    private readonly fetchJson: PublicHttpFetch = publicHttpFetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  supports(target: { adapterId: string }): boolean {
    return target.adapterId === this.id;
  }

  async collect(request: {
    target: { id: string; url: string };
    since: string;
    until: string;
  }): Promise<SourceCollectionResult> {
    const startedAt = this.now().toISOString();
    const route = request.target.url;
    const url = new URL(route);
    // Algolia exposes up to 1,000 hits per query. Bound work to ten pages and
    // report any provider or local truncation without advancing the checkpoint.
    const pageSize = 100;
    const maxPages = 10;
    url.searchParams.set("hitsPerPage", String(pageSize));
    const sinceMs = Date.parse(request.since);
    const untilMs = Date.parse(request.until);
    const filters = [url.searchParams.get("numericFilters")];
    if (Number.isFinite(sinceMs)) filters.push(`created_at_i>=${Math.floor(sinceMs / 1000)}`);
    if (Number.isFinite(untilMs)) filters.push(`created_at_i<=${Math.floor(untilMs / 1000)}`);
    url.searchParams.set("numericFilters", filters.filter(Boolean).join(","));

    const hitsById = new Map<string, AlgoliaHit>();
    const bodies: string[] = [];
    let collectionFailure: SourceCollectionResult | null = null;
    let contentType: string | null = null;
    let advertisedPages = 1;
    let providerTruncated = false;
    for (let page = 0; page < Math.min(advertisedPages, maxPages); page += 1) {
      url.searchParams.set("page", String(page));
      let response;
      try {
        response = await this.fetchJson(url.toString());
      } catch (error) {
        collectionFailure = failed(
          this.version,
          route,
          "internal_failure",
          null,
          error instanceof Error ? error.message : String(error),
          startedAt,
          this.now().toISOString(),
        );
        break;
      }
      contentType = response.contentType;
      bodies.push(response.body);
      if (response.status !== 200) {
        const classification: FailedOutcome =
          response.status === 429
            ? "rate_limit"
            : response.status === 401 || response.status === 403
              ? "blocked_access"
              : "internal_failure";
        collectionFailure = failed(
          this.version,
          route,
          classification,
          response.status,
          `Hacker News (Algolia) answered ${response.status} on page ${page}`,
          startedAt,
          this.now().toISOString(),
          response.status === 429
            ? retryAfterMilliseconds(response.retryAfter, this.now())
            : undefined,
        );
        break;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(response.body);
      } catch (error) {
        collectionFailure = failed(
          this.version,
          route,
          "parser_failure",
          response.status,
          error instanceof Error ? error.message : String(error),
          startedAt,
          this.now().toISOString(),
        );
        break;
      }
      const checked = AlgoliaPageSchema.safeParse(raw);
      if (!checked.success || (checked.data.page !== undefined && checked.data.page !== page)) {
        collectionFailure = failed(
          this.version,
          route,
          "response_shape_change",
          response.status,
          `Hacker News returned an invalid hits page ${page}`,
          startedAt,
          this.now().toISOString(),
        );
        break;
      }
      const parsed = checked.data;
      advertisedPages = Math.max(advertisedPages, parsed.nbPages ?? 1);
      if (parsed.nbHits !== undefined && parsed.nbHits > (parsed.nbPages ?? 1) * pageSize)
        providerTruncated = true;
      for (const hit of parsed.hits) {
        const publishedMs = hit.created_at ? Date.parse(hit.created_at) : Number.NaN;
        if (
          Number.isFinite(publishedMs) &&
          ((Number.isFinite(sinceMs) && publishedMs < sinceMs) ||
            (Number.isFinite(untilMs) && publishedMs > untilMs))
        )
          continue;
        hitsById.set(hit.objectID, hit);
      }
      if (
        parsed.hits.length >= pageSize &&
        (parsed.nbPages === undefined ||
          parsed.nbHits === undefined ||
          parsed.nbPages <= page ||
          parsed.nbHits < parsed.hits.length)
      ) {
        collectionFailure = failed(
          this.version,
          route,
          "response_shape_change",
          response.status,
          `Hacker News returned missing or inconsistent pagination metadata for full page ${page}; collection coverage is unknown.`,
          startedAt,
          this.now().toISOString(),
        );
        break;
      }
    }
    if (!collectionFailure && (advertisedPages > maxPages || providerTruncated)) {
      collectionFailure = failed(
        this.version,
        route,
        "unsupported_capability",
        200,
        "Hacker News results are truncated by the 1,000-hit / ten-page collection limit; narrow the time window.",
        startedAt,
        this.now().toISOString(),
      );
      collectionFailure.diagnostic.affectedCapabilities = ["items"];
    }
    const hits = [...hitsById.values()];
    const finishedAt = this.now().toISOString();
    const retrievedAt = this.now().toISOString();
    const items: SourceItem[] = hits.map((hit) => {
      const objectID = hit.objectID;
      const title = hit.title ?? hit.story_title ?? null;
      const body = hit.story_text ?? hit.comment_text ?? null;
      return {
        id: `hn_${objectID}`,
        externalId: `hn:${objectID}`,
        targetId: request.target.id,
        adapterId: this.id,
        canonicalUrl: `https://news.ycombinator.com/item?id=${objectID}`,
        author: hit.author ?? null,
        title,
        body,
        description: null,
        publishedAt: hit.created_at ?? null,
        discoveredAt: retrievedAt,
        media: [],
        transcript: null,
        comments: [],
        evidence: [{ route, retrievedAt }],
        /* Algolia reports a story's points; that is HN's engagement surface and
           the only count this adapter observes. */
        ...(typeof hit.points === "number" ? { engagement: { hnPoints: hit.points } } : {}),
        completeness: {
          title: fieldState(title !== null),
          body: fieldState(body !== null),
          description: "unavailable",
          transcript: "unsupported",
          comments: "unsupported",
          media: "unsupported",
        },
      } satisfies SourceItem;
    });

    if (collectionFailure)
      return {
        ...collectionFailure,
        items,
        diagnostic: {
          ...collectionFailure.diagnostic,
          contentType,
          responseHash: bodies.length > 0 ? responseHash(bodies.join("\n")) : "",
          parserStage:
            collectionFailure.outcome === "parser_failure" ||
            collectionFailure.outcome === "response_shape_change" ||
            collectionFailure.outcome === "unsupported_capability"
              ? "adapter_boundary"
              : "fetch",
        },
      };
    return {
      kind: "completed",
      outcome: items.length > 0 ? "items_found" : "legitimate_empty",
      items,
      checkpoint: request.until,
      diagnostic: {
        classification: items.length > 0 ? "items_found" : "legitimate_empty",
        route,
        status: 200,
        contentType,
        parserStage: "adapter_boundary",
        responseHash: responseHash(bodies.join("\n")),
        adapterVersion: this.version,
        startedAt,
        finishedAt,
        retries: 0,
        affectedCapabilities: [],
        causeChain: [],
      },
    };
  }
}
