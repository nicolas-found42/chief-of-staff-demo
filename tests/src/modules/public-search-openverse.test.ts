import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenverseProvider } from "../../../apps/server/src/source-adapters/providers/openverse";
import { ProviderRefusedError } from "../../../apps/server/src/source-adapters/providers/types";
import type { SearchProviderIo } from "../../../apps/server/src/source-adapters/providers/types";
import type {
  PublicHttpFetch,
  PublicHttpResponse,
} from "../../../apps/server/src/source-adapters/http";
import type * as undiciModule from "undici";

/* The curated transports ride undici's own fetch (pooled dispatcher — see
   http.ts), so these tests intercept at the undici module boundary: the
   real createHttpFetch guard, header binding and timeout code still run;
   only the socket layer is faked. */
const undiciStub = vi.hoisted(() => ({
  impl: null as
    null | ((input: string | URL, init?: { headers?: HeadersInit }) => Promise<Response>),
}));
vi.mock("undici", async (importOriginal) => {
  const actual = await importOriginal<typeof undiciModule>();
  return {
    ...actual,
    /* The cast bridges the stub's narrow init type to undici's full one. */
    fetch: ((input: string | URL, init?: { headers?: HeadersInit }) => {
      if (!undiciStub.impl) throw new Error("the undici fetch stub is not installed");
      return undiciStub.impl(input, init);
    }) as unknown as typeof actual.fetch,
  };
});

async function refused(promise: Promise<unknown>): Promise<ProviderRefusedError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ProviderRefusedError) return error;
    throw error;
  }
  throw new Error("expected the provider to refuse");
}

const IO: SearchProviderIo = {
  fetch: async () => {
    throw new Error("io.fetch is not used by this provider under test");
  },
  timeoutMs: 5_000,
};

function fetchAnswering(
  status: number,
  body: string,
  retryAfter: string | null = null,
): { fetch: PublicHttpFetch; urls: string[]; timeouts: (number | undefined)[] } {
  const urls: string[] = [];
  const timeouts: (number | undefined)[] = [];
  const fetch: PublicHttpFetch = async (url, options) => {
    urls.push(url);
    timeouts.push(options?.timeoutMs);
    const response: PublicHttpResponse = {
      url,
      status,
      contentType: "application/json",
      etag: null,
      lastModified: null,
      retryAfter,
      body,
    };
    return response;
  };
  return { fetch, urls, timeouts };
}

const FIXTURE = JSON.stringify({
  results: [
    {
      title: "Fjord at dusk",
      url: "https://api.openverse.org/v1/images/abc/download/",
      foreign_landing_url: "https://commons.wikimedia.org/wiki/File:Fjord.jpg",
      description: "A photograph of a fjord at dusk",
    },
    { title: "Direct asset only", url: "https://example.org/painting.png" },
    { title: "No usable link at all" },
  ],
});

describe("createOpenverseProvider", () => {
  it("prefers the foreign landing page and drops results without a usable URL", async () => {
    const { fetch, urls, timeouts } = fetchAnswering(200, FIXTURE);
    const results = await createOpenverseProvider({ fetch }).search("fjord", IO);
    expect(urls).toEqual(["https://api.openverse.org/v1/images/?q=fjord&page_size=8&format=json"]);
    // The slow-source deadline overrides the composite's shorter default.
    expect(timeouts[0]).toBe(60_000);
    expect(results).toEqual([
      {
        title: "Fjord at dusk",
        url: "https://commons.wikimedia.org/wiki/File:Fjord.jpg",
        snippet: "A photograph of a fjord at dusk",
      },
      { title: "Direct asset only", url: "https://example.org/painting.png", snippet: "" },
    ]);
  });

  it("refuses HTTP 503 as rate-limited", async () => {
    const { fetch } = fetchAnswering(503, "busy");
    const error = await refused(createOpenverseProvider({ fetch }).search("q", IO));
    expect(error.reason).toBe("rate-limited");
  });

  it("refuses other non-200 answers as errors", async () => {
    const { fetch } = fetchAnswering(500, "boom");
    const error = await refused(createOpenverseProvider({ fetch }).search("q", IO));
    expect(error.reason).toBe("error");
  });

  it("refuses a 200 that is not the results shape", async () => {
    const { fetch } = fetchAnswering(200, "not json");
    const error = await refused(createOpenverseProvider({ fetch }).search("q", IO));
    expect(error.reason).toBe("error");
  });

  it("answers a clean empty page with []", async () => {
    const { fetch } = fetchAnswering(200, JSON.stringify({ results: [] }));
    await expect(createOpenverseProvider({ fetch }).search("q", IO)).resolves.toEqual([]);
  });

  // Ride the real curated transport and stub the undici fetch module it
  // sits on — the injected-fetch pattern alone would bypass the accept
  // binding that the live HTML-page diagnosis hinged on.
  afterEach(() => {
    undiciStub.impl = null;
  });

  it("binds a JSON accept to its curated transport", async () => {
    const accepts: (string | undefined)[] = [];
    undiciStub.impl = async (_input, init) => {
      accepts.push(new Headers(init?.headers).get("accept") ?? undefined);
      return new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const results = await createOpenverseProvider().search("fjord", IO);
    expect(results).toEqual([]);
    expect(accepts[0]).toBe("application/json");
  });
});
