import { describe, expect, it, vi } from "vitest";
import { HnAlgoliaSourceAdapter } from "../../../apps/server/src/modules/content-research/adapters/hn";
import type { PublicHttpResponse } from "../../../apps/server/src/source-adapters/http";
import { responseHash } from "../../../apps/server/src/source-adapters/http";

const now = () => new Date("2026-10-08T12:00:00.000Z");
const request = {
  target: { id: "hn-person", url: "https://hn.algolia.com/api/v1/search_by_date?tags=author_test" },
  since: "2026-10-01T00:00:00.000Z",
  until: "2026-10-07T00:00:00.000Z",
};
function hit(id: string, date = "2026-10-05T00:00:00.000Z") {
  return { objectID: id, title: `Story ${id}`, created_at: date, points: 7 };
}
function response(data: unknown, status = 200): PublicHttpResponse {
  return {
    url: request.target.url,
    status,
    contentType: "application/json",
    etag: null,
    lastModified: null,
    retryAfter: null,
    body: JSON.stringify(data),
  };
}

describe("Content Research HN coverage", () => {
  it("collects every advertised page within its bound and deduplicates repeated hits", async () => {
    const fetch = vi.fn(async (value: string) => {
      const page = Number(new URL(value).searchParams.get("page") ?? 0);
      return response({
        page,
        nbPages: 2,
        nbHits: 3,
        hits: page === 0 ? [hit("1"), hit("2")] : [hit("2"), hit("3")],
      });
    });
    const result = await new HnAlgoliaSourceAdapter(fetch, now).collect(request);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(result.items.map((item) => item.externalId)).toEqual(["hn:1", "hn:2", "hn:3"]);
    expect(result.kind).toBe("completed");
  });

  it("bounds both ends of the requested interval in the request and returned items", async () => {
    const fetch = vi.fn(async (_url: string) =>
      response({
        hits: [
          hit("old", "2026-09-30T00:00:00Z"),
          hit("inside"),
          hit("future", "2026-10-09T00:00:00Z"),
        ],
      }),
    );
    const result = await new HnAlgoliaSourceAdapter(fetch, now).collect(request);
    const filters = new URL(fetch.mock.calls[0][0]).searchParams.get("numericFilters");
    expect(filters).toContain(`created_at_i>=${Date.parse(request.since) / 1000}`);
    expect(filters).toContain(`created_at_i<=${Date.parse(request.until) / 1000}`);
    expect(result.items.map((item) => item.externalId)).toEqual(["hn:inside"]);
  });

  it.each([{}, { hits: "changed" }, { hits: [null] }, { hits: [{ title: "missing id" }] }])(
    "does not call malformed successful responses legitimate empty: %j",
    async (data) => {
      const result = await new HnAlgoliaSourceAdapter(async () => response(data), now).collect(
        request,
      );
      expect(result).toMatchObject({
        kind: "failed",
        outcome: "response_shape_change",
        checkpoint: null,
        diagnostic: {
          contentType: "application/json",
          responseHash: responseHash(JSON.stringify(data)),
          parserStage: "adapter_boundary",
        },
      });
    },
  );

  it("preserves earlier pages and leaves no checkpoint after a later page rate limit", async () => {
    const fetch = vi.fn(async (value: string) =>
      Number(new URL(value).searchParams.get("page") ?? 0) === 0
        ? response({ hits: [hit("1")], nbPages: 2, nbHits: 2 })
        : { ...response({}, 429), retryAfter: "3" },
    );
    const result = await new HnAlgoliaSourceAdapter(fetch, now).collect(request);
    expect(result).toMatchObject({
      kind: "failed",
      outcome: "rate_limit",
      checkpoint: null,
      diagnostic: {
        retryAfterMs: 3000,
        contentType: "application/json",
        responseHash: responseHash(
          [JSON.stringify({ hits: [hit("1")], nbPages: 2, nbHits: 2 }), "{}"].join("\n"),
        ),
        parserStage: "fetch",
      },
    });
    expect(result.items.map((item) => item.externalId)).toEqual(["hn:1"]);
  });

  it("reports truncation and preserves collected items when the page budget is exhausted", async () => {
    const fetch = vi.fn(async (value: string) => {
      const page = Number(new URL(value).searchParams.get("page") ?? 0);
      return response({ page, nbPages: 11, nbHits: 1100, hits: [hit(String(page))] });
    });
    const result = await new HnAlgoliaSourceAdapter(fetch, now).collect(request);
    expect(fetch).toHaveBeenCalledTimes(10);
    expect(result).toMatchObject({
      kind: "failed",
      outcome: "unsupported_capability",
      checkpoint: null,
      diagnostic: {
        contentType: "application/json",
        responseHash: responseHash(
          Array.from({ length: 10 }, (_, page) =>
            JSON.stringify({ page, nbPages: 11, nbHits: 1100, hits: [hit(String(page))] }),
          ).join("\n"),
        ),
        parserStage: "adapter_boundary",
      },
    });
    expect(result.items).toHaveLength(10);
    expect(result.diagnostic.causeChain.join(" ")).toMatch(/limit|truncat|budget/i);
  });

  it("keeps a valid empty page a successful empty collection", async () => {
    const result = await new HnAlgoliaSourceAdapter(
      async () => response({ hits: [], nbPages: 0, nbHits: 0 }),
      now,
    ).collect(request);
    expect(result).toMatchObject({ kind: "completed", outcome: "legitimate_empty", items: [] });
  });
});

describe("Content Research HN failure holdouts", () => {
  it.each([
    {},
    { nbPages: 1 },
    { nbHits: 100 },
    { nbPages: 0, nbHits: 100 },
    { nbPages: 1, nbHits: 99 },
  ])("retains an ambiguous full page without declaring completion: %j", async (metadata) => {
    const result = await new HnAlgoliaSourceAdapter(
      async () =>
        response({
          hits: Array.from({ length: 100 }, (_, index) => hit(String(index))),
          ...metadata,
        }),
      now,
    ).collect(request);
    expect(result).toMatchObject({
      kind: "failed",
      outcome: "response_shape_change",
      checkpoint: null,
      diagnostic: { affectedCapabilities: ["items"] },
    });
    expect(result.items).toHaveLength(100);
    expect(result.diagnostic.causeChain.join(" ")).toMatch(/pagination/i);
  });

  it("reports provider truncation below the local page budget", async () => {
    const adapter = new HnAlgoliaSourceAdapter(
      async () => response({ hits: [hit("1")], nbPages: 1, nbHits: 150 }),
      now,
    );
    const result = await adapter.collect(request);
    expect(result).toMatchObject({
      kind: "failed",
      outcome: "unsupported_capability",
      checkpoint: null,
    });
    expect(result.items).toHaveLength(1);
  });

  it("retains the first page when the next page has invalid JSON", async () => {
    const adapter = new HnAlgoliaSourceAdapter(
      async (value) =>
        new URL(value).searchParams.get("page") === "0"
          ? response({ hits: [hit("1")], nbPages: 2, nbHits: 2 })
          : { ...response({}), body: "{broken" },
      now,
    );
    const result = await adapter.collect(request);
    expect(result).toMatchObject({
      kind: "failed",
      outcome: "parser_failure",
      checkpoint: null,
      diagnostic: {
        contentType: "application/json",
        responseHash: responseHash(
          [JSON.stringify({ hits: [hit("1")], nbPages: 2, nbHits: 2 }), "{broken"].join("\n"),
        ),
        parserStage: "adapter_boundary",
      },
    });
    expect(result.items.map((item) => item.externalId)).toEqual(["hn:1"]);
  });

  it("retains earlier response evidence when the next fetch throws", async () => {
    const firstPage = { hits: [hit("1")], nbPages: 2, nbHits: 2 };
    const adapter = new HnAlgoliaSourceAdapter(async (value) => {
      if (new URL(value).searchParams.get("page") === "0") return response(firstPage);
      throw new Error("connection closed");
    }, now);
    const result = await adapter.collect(request);
    expect(result).toMatchObject({
      kind: "failed",
      outcome: "internal_failure",
      checkpoint: null,
      diagnostic: {
        contentType: "application/json",
        responseHash: responseHash(JSON.stringify(firstPage)),
        parserStage: "fetch",
        causeChain: ["connection closed"],
      },
    });
    expect(result.items.map((item) => item.externalId)).toEqual(["hn:1"]);
  });
});
