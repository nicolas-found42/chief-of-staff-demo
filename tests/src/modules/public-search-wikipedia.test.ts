import { describe, expect, it } from "vitest";
import { createWikipediaProvider } from "../../../apps/server/src/source-adapters/providers/wikipedia";
import { ProviderRefusedError } from "../../../apps/server/src/source-adapters/providers/types";
import {
  createPublicSearch,
  PublicSearchUnavailableError,
} from "../../../apps/server/src/source-adapters/search";

const IO = {
  timeoutMs: 10_000,
  fetch: async () => {
    throw new Error("io.fetch is not used by this provider under test");
  },
};

function respondWith(status: number, body: string, retryAfter: string | null = null) {
  const calls: string[] = [];
  const fetch = async (url: string) => {
    calls.push(url);
    return {
      url,
      status,
      contentType: "application/json",
      etag: null,
      lastModified: null,
      retryAfter,
      body,
    };
  };
  return { fetch, calls };
}

const FIXTURE = [
  "ada",
  ["Ada Lovelace", "Ada Programming Language", "Ada, Michigan"],
  ["English writer", "A language", "A town"],
  [
    "https://en.wikipedia.org/wiki/Ada_Lovelace",
    "https://en.wikipedia.org/wiki/Ada_(programming_language)",
    "not a url",
  ],
];

describe("createWikipediaProvider", () => {
  it("maps the positional opensearch arrays by index and drops URL-less entries", async () => {
    const { fetch } = respondWith(200, JSON.stringify(FIXTURE));
    const provider = createWikipediaProvider({ fetch });

    const results = await provider.search("ada", IO);

    expect(results).toEqual([
      {
        title: "Ada Lovelace",
        url: "https://en.wikipedia.org/wiki/Ada_Lovelace",
        snippet: "English writer",
      },
      {
        title: "Ada Programming Language",
        url: "https://en.wikipedia.org/wiki/Ada_(programming_language)",
        snippet: "A language",
      },
    ]);
  });

  it("requests the opensearch endpoint with the encoded query", async () => {
    const { fetch, calls } = respondWith(200, JSON.stringify(["q", [], [], []]));
    const provider = createWikipediaProvider({ fetch });

    await provider.search("cold fusion", IO);

    expect(calls).toEqual([
      "https://en.wikipedia.org/w/api.php?action=opensearch&search=cold%20fusion&limit=8&format=json&namespace=0",
    ]);
  });

  it("classifies a non-200 as an error refusal", async () => {
    const { fetch } = respondWith(503, "upstream error");
    const provider = createWikipediaProvider({ fetch });

    const error = await provider.search("ada", IO).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderRefusedError);
    expect((error as ProviderRefusedError).reason).toBe("error");
  });

  it.each([
    { retryAfter: null, waitMs: 3_600_000 },
    { retryAfter: "7200", waitMs: 7_200_000 },
  ])(
    "rests after HTTP 429 with Retry-After $retryAfter across queries",
    async ({ retryAfter, waitMs }) => {
      // #432 captured HTTP 429 but no body/header. The longer wait is a
      // synthetic contract case, not a reconstruction of the historical response.
      const refused = respondWith(429, "", retryAfter);
      const recovered = respondWith(200, JSON.stringify(FIXTURE));
      let now = 0;
      const search = createPublicSearch(
        async (url) => (refused.calls.length === 0 ? refused.fetch(url) : recovered.fetch(url)),
        undefined,
        { now: () => now, providerFilter: (name) => name === "wikipedia" },
      );

      await expect(search("Richard Achee")).rejects.toBeInstanceOf(PublicSearchUnavailableError);
      now = waitMs - 1;
      await expect(search("Ada Lovelace")).rejects.toBeInstanceOf(PublicSearchUnavailableError);
      expect(recovered.calls).toEqual([]);

      now = waitMs;
      await expect(search("Ada Lovelace")).resolves.toEqual([
        expect.objectContaining({ url: "https://en.wikipedia.org/wiki/Ada_Lovelace" }),
        expect.objectContaining({
          url: "https://en.wikipedia.org/wiki/Ada_(programming_language)",
        }),
      ]);
      expect(refused.calls).toHaveLength(1);
      expect(recovered.calls).toHaveLength(1);
    },
  );

  it("classifies an unparseable 200 body as an error refusal", async () => {
    const { fetch } = respondWith(200, "not json");
    const provider = createWikipediaProvider({ fetch });

    const error = await provider.search("ada", IO).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderRefusedError);
    expect((error as ProviderRefusedError).reason).toBe("error");
  });

  it("classifies a 200 body without the positional shape as an error refusal", async () => {
    const { fetch } = respondWith(200, JSON.stringify({ error: "unexpected shape" }));
    const provider = createWikipediaProvider({ fetch });

    const error = await provider.search("ada", IO).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderRefusedError);
    expect((error as ProviderRefusedError).reason).toBe("error");
  });

  it("answers a clean 200 with no matches as []", async () => {
    const { fetch } = respondWith(200, JSON.stringify(["nothing", [], [], []]));
    const provider = createWikipediaProvider({ fetch });

    await expect(provider.search("nothing", IO)).resolves.toEqual([]);
  });
});
