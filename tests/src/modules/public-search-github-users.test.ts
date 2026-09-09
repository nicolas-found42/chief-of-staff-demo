import { afterEach, describe, expect, it, vi } from "vitest";
import { createGitHubUsersProvider } from "../../../apps/server/src/source-adapters/providers/github-users";
import { ProviderRefusedError } from "../../../apps/server/src/source-adapters/providers/types";
import type { PublicHttpResponse } from "../../../apps/server/src/source-adapters/http";
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

const io = {
  timeoutMs: 5_000,
  fetch: async () => {
    throw new Error("io.fetch is not used by this provider under test");
  },
};

function respondWith(status: number, body: string, calls: { url: string }[] = []) {
  return async (url: string): Promise<PublicHttpResponse> => {
    calls.push({ url });
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
}

describe("createGitHubUsersProvider", () => {
  it("maps the search fixture with empty snippets and no follow-up requests", async () => {
    const body = JSON.stringify({
      items: [
        { login: "gaearon", html_url: "https://github.com/gaearon" },
        { login: "sindresorhus", html_url: "https://github.com/sindresorhus" },
      ],
    });
    const calls: { url: string }[] = [];
    const provider = createGitHubUsersProvider({ fetch: respondWith(200, body, calls) });
    await expect(provider.search("dan abramov", io)).resolves.toEqual([
      { title: "gaearon", url: "https://github.com/gaearon", snippet: "" },
      { title: "sindresorhus", url: "https://github.com/sindresorhus", snippet: "" },
    ]);
    // One request total: enrichment-only budget, no per-user core calls.
    expect(calls).toHaveLength(1);
  });

  it("searches the unauthenticated users endpoint with a per_page cap", async () => {
    const calls: { url: string }[] = [];
    const provider = createGitHubUsersProvider({
      fetch: respondWith(200, JSON.stringify({ items: [] }), calls),
    });
    await provider.search("ada lovelace", io);
    expect(calls[0]?.url).toBe("https://api.github.com/search/users?q=ada%20lovelace&per_page=8");
  });

  it("refuses a 403 as an error", async () => {
    const provider = createGitHubUsersProvider({ fetch: respondWith(403, "rate limited") });
    const refusal = await provider.search("x", io).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ProviderRefusedError);
    expect((refusal as ProviderRefusedError).reason).toBe("error");
  });

  it("refuses a 429 as rate-limited", async () => {
    const provider = createGitHubUsersProvider({ fetch: respondWith(429, "slow down") });
    const refusal = await provider.search("x", io).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ProviderRefusedError);
    expect((refusal as ProviderRefusedError).reason).toBe("rate-limited");
  });

  it("refuses a 200 body that is not JSON", async () => {
    const provider = createGitHubUsersProvider({ fetch: respondWith(200, "<html>nope</html>") });
    const refusal = await provider.search("x", io).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ProviderRefusedError);
    expect((refusal as ProviderRefusedError).reason).toBe("error");
  });

  it("refuses a 200 with an unexpected shape", async () => {
    const provider = createGitHubUsersProvider({
      fetch: respondWith(200, JSON.stringify({ total_count: 0 })),
    });
    const refusal = await provider.search("x", io).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ProviderRefusedError);
    expect((refusal as ProviderRefusedError).reason).toBe("error");
  });

  it("answers a clean empty result set with []", async () => {
    const provider = createGitHubUsersProvider({
      fetch: respondWith(200, JSON.stringify({ items: [] })),
    });
    await expect(provider.search("nobody", io)).resolves.toEqual([]);
  });
  // Ride the real curated transport and stub the undici fetch module it
  // sits on — the injected-fetch pattern alone would bypass the header
  // binding that the live 415 diagnosis hinged on.
  afterEach(() => {
    undiciStub.impl = null;
  });

  it("binds the GitHub media-type accept to its curated transport", async () => {
    const accepts: (string | undefined)[] = [];
    undiciStub.impl = async (_input, init) => {
      accepts.push(new Headers(init?.headers).get("accept") ?? undefined);
      return new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const provider = createGitHubUsersProvider();
    await expect(provider.search("nobody", io)).resolves.toEqual([]);
    expect(accepts[0]).toBe("application/vnd.github+json");
  });
});
