import { describe, expect, it } from "vitest";
import { createWikidataProvider } from "../../../apps/server/src/source-adapters/providers/wikidata";
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

function respondWith(status: number, body: string) {
  const calls: string[] = [];
  const fetch = async (url: string) => {
    calls.push(url);
    return {
      url,
      status,
      contentType: "application/json",
      etag: null,
      lastModified: null,
      retryAfter: null,
      body,
    };
  };
  return { fetch, calls };
}

const FIXTURE = {
  search: [
    {
      label: "Ada Lovelace",
      description: "English mathematician",
      concepturi: "https://www.wikidata.org/wiki/Q7259",
    },
    { label: "Ada County", description: "county in Idaho", concepturi: "relative/only" },
    { label: "No URI", description: "no concepturi at all" },
  ],
};

describe("createWikidataProvider", () => {
  it("maps label/description/concepturi and drops entities without a usable URL", async () => {
    const { fetch } = respondWith(200, JSON.stringify(FIXTURE));
    const provider = createWikidataProvider({ fetch });

    const results = await provider.search("ada", IO);

    expect(results).toEqual([
      {
        title: "Ada Lovelace",
        url: "https://www.wikidata.org/wiki/Q7259",
        snippet: "English mathematician",
      },
    ]);
  });

  it("requests wbsearchentities with the encoded query", async () => {
    const { fetch, calls } = respondWith(200, JSON.stringify({ search: [] }));
    const provider = createWikidataProvider({ fetch });

    await provider.search("cold fusion", IO);

    expect(calls).toEqual([
      "https://www.wikidata.org/w/api.php?action=wbsearchentities&search=cold%20fusion&language=en&format=json&limit=8",
    ]);
  });

  it("classifies a non-200 as an error refusal", async () => {
    const { fetch } = respondWith(503, "upstream error");
    const provider = createWikidataProvider({ fetch });

    const error = await provider.search("ada", IO).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderRefusedError);
    expect((error as ProviderRefusedError).reason).toBe("error");
  });

  it("classifies the historical HTTP 429 as rate-limited without a captured Retry-After", async () => {
    const { fetch } = respondWith(429, "");
    const provider = createWikidataProvider({ fetch });

    const refusal = await provider.search("Richard Achee", IO).catch((caught: unknown) => caught);

    expect(refusal).toBeInstanceOf(ProviderRefusedError);
    expect(refusal).toMatchObject({ reason: "rate-limited", retryAfterMs: undefined });
  });

  it("honors Wikidata Retry-After beyond the minimum cooldown and resumes at the deadline", async () => {
    const calls: string[] = [];
    let now = 0;
    const search = createPublicSearch(
      async (url) => {
        calls.push(url);
        const limited = calls.length === 1;
        return {
          url,
          status: limited ? 429 : 200,
          contentType: "application/json",
          etag: null,
          lastModified: null,
          retryAfter: limited ? "7200" : null,
          body: limited ? "" : JSON.stringify(FIXTURE),
        };
      },
      undefined,
      { now: () => now, providerFilter: (name) => name === "wikidata" },
    );

    await expect(search("Ada Lovelace")).rejects.toBeInstanceOf(PublicSearchUnavailableError);
    now = 3_600_001;
    await expect(search("Ada Lovelace")).rejects.toBeInstanceOf(PublicSearchUnavailableError);
    now = 7_199_999;
    await expect(search("Ada Lovelace")).rejects.toBeInstanceOf(PublicSearchUnavailableError);
    expect(calls).toHaveLength(1);

    now = 7_200_000;
    await expect(search("Ada Lovelace")).resolves.toEqual([
      expect.objectContaining({
        title: "Ada Lovelace",
        url: "https://www.wikidata.org/wiki/Q7259",
        upstreamIndex: "wikidata",
      }),
    ]);
    expect(calls).toHaveLength(2);
  });

  it("classifies an unparseable 200 body as an error refusal", async () => {
    const { fetch } = respondWith(200, "not json");
    const provider = createWikidataProvider({ fetch });

    const error = await provider.search("ada", IO).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderRefusedError);
    expect((error as ProviderRefusedError).reason).toBe("error");
  });

  it("classifies a 200 body without search[] as an error refusal", async () => {
    const { fetch } = respondWith(200, JSON.stringify({ error: "unexpected shape" }));
    const provider = createWikidataProvider({ fetch });

    const error = await provider.search("ada", IO).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderRefusedError);
    expect((error as ProviderRefusedError).reason).toBe("error");
  });

  it("answers a clean 200 with no matches as []", async () => {
    const { fetch } = respondWith(200, JSON.stringify({ search: [] }));
    const provider = createWikidataProvider({ fetch });

    await expect(provider.search("nothing", IO)).resolves.toEqual([]);
  });
});
