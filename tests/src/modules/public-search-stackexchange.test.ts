import { describe, expect, it, vi } from "vitest";
import { createStackExchangeProvider } from "../../../apps/server/src/source-adapters/providers/stackexchange";
import { ProviderRefusedError } from "../../../apps/server/src/source-adapters/providers/types";
import type { SearchProviderIo } from "../../../apps/server/src/source-adapters/providers/types";
import type {
  PublicHttpFetch,
  PublicHttpResponse,
} from "../../../apps/server/src/source-adapters/http";

async function refused(promise: Promise<unknown>): Promise<ProviderRefusedError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ProviderRefusedError) return error;
    throw error;
  }
  throw new Error("expected the provider to refuse");
}

function fetchAnswering(
  status: number,
  body: string,
  retryAfter: string | null = null,
): { fetch: PublicHttpFetch; urls: string[] } {
  const urls: string[] = [];
  const fetch: PublicHttpFetch = async (url) => {
    urls.push(url);
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
  return { fetch, urls };
}

const FIXTURE = JSON.stringify({
  items: [
    {
      title: "How do I await inside forEach?",
      question_id: 37572652,
      excerpt:
        'You cannot <span class="highlight">await</span> inside forEach; use <span class="highlight">for...of</span> or Promise.all.',
    },
    { title: "Plain question", question_id: 42, excerpt: "No markup here." },
  ],
});

describe("createStackExchangeProvider", () => {
  it("honors the IP throttle carried by a real HTTP 400 API error", async () => {
    const { fetch } = fetchAnswering(
      400,
      JSON.stringify({
        error_id: 502,
        error_name: "throttle_violation",
        error_message: "too many requests from this IP, more requests available in 13630 seconds",
      }),
    );
    const error = await refused(
      createStackExchangeProvider().search("Richard Achee", { fetch, timeoutMs: 5000 }),
    );
    expect(error.reason).toBe("rate-limited");
    expect(error.retryAfterMs).toBe(13_630_000);
  });

  it("maps excerpt hits to results, keeping the highlighted words without the markup", async () => {
    const { fetch, urls } = fetchAnswering(200, FIXTURE);
    const results = await createStackExchangeProvider().search("await inside foreach", {
      fetch,
      timeoutMs: 5_000,
    } satisfies SearchProviderIo);
    expect(urls).toEqual([
      "https://api.stackexchange.com/2.3/search/excerpts?order=desc&sort=relevance&q=await%20inside%20foreach&site=stackoverflow",
    ]);
    expect(results).toEqual([
      {
        title: "How do I await inside forEach?",
        url: "https://stackoverflow.com/q/37572652",
        snippet: "You cannot await inside forEach; use for...of or Promise.all.",
      },
      {
        title: "Plain question",
        url: "https://stackoverflow.com/q/42",
        snippet: "No markup here.",
      },
    ]);
  });

  it("refuses HTTP 429 as rate-limited and honors Retry-After", async () => {
    const { fetch } = fetchAnswering(429, "", "120");
    const error = await refused(
      createStackExchangeProvider().search("q", { fetch, timeoutMs: 5_000 }),
    );
    expect(error.reason).toBe("rate-limited");
    expect(error.retryAfterMs).toBe(120_000);
  });

  it("preserves a successful answer while honoring its method backoff", async () => {
    const body = JSON.stringify({ ...JSON.parse(FIXTURE), backoff: 10 });
    const { fetch } = fetchAnswering(200, body);
    const onBackoff = vi.fn();
    const results = await createStackExchangeProvider().search("q", {
      fetch,
      timeoutMs: 5_000,
      onBackoff,
    });
    expect(results).toHaveLength(2);
    expect(onBackoff).toHaveBeenCalledExactlyOnceWith(10_000);
  });

  it("refuses a 200 that is not the excerpts shape", async () => {
    const { fetch } = fetchAnswering(200, "<html>not json</html>");
    const error = await refused(
      createStackExchangeProvider().search("q", { fetch, timeoutMs: 5_000 }),
    );
    expect(error.reason).toBe("error");
  });

  it("refuses other non-200 answers as errors", async () => {
    const { fetch } = fetchAnswering(500, "boom");
    const error = await refused(
      createStackExchangeProvider().search("q", { fetch, timeoutMs: 5_000 }),
    );
    expect(error.reason).toBe("error");
  });

  it("answers a clean empty page with []", async () => {
    const { fetch } = fetchAnswering(200, JSON.stringify({ items: [] }));
    await expect(
      createStackExchangeProvider().search("q", { fetch, timeoutMs: 5_000 }),
    ).resolves.toEqual([]);
  });

  it("caps the page at 8 results and slices overlong fields", async () => {
    const items = Array.from({ length: 9 }, (_, index) => ({
      title: index === 0 ? "t".repeat(250) : `Title ${String(index)}`,
      question_id: 1000 + index,
      excerpt: index === 0 ? "e".repeat(500) : `Excerpt ${String(index)}`,
    }));
    const { fetch } = fetchAnswering(200, JSON.stringify({ items }));
    const results = await createStackExchangeProvider().search("q", {
      fetch,
      timeoutMs: 5_000,
    });
    expect(results).toHaveLength(8);
    expect(results[0]).toEqual({
      title: "t".repeat(200),
      url: "https://stackoverflow.com/q/1000",
      snippet: "e".repeat(400),
    });
    expect(results[7]).toEqual({
      title: "Title 7",
      url: "https://stackoverflow.com/q/1007",
      snippet: "Excerpt 7",
    });
  });
});
